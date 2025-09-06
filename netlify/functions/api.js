// Importar módulos necesarios
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Papa from 'papaparse'; // Para exportar a CSV
import pool from './db.js'; // Importar el pool de conexión a la BD

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middlewares
app.use(cors());
app.use(express.json());

// --- GESTIÓN DE TORNEOS ---

// Crear un nuevo torneo
app.post('/api/tournaments', async (req, res) => {
    const { name } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'El nombre del torneo es requerido.' });
    }
    try {
        const { rows } = await pool.query(
            'INSERT INTO tournaments (name) VALUES ($1) RETURNING *',
            [name]
        );
        res.status(201).json(rows[0]);
    } catch (error) {
        console.error('Error creating tournament:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Obtener todos los torneos
app.get('/api/tournaments', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM tournaments ORDER BY created_at DESC');
        res.json(rows);
    } catch (error) {
        console.error('Error fetching tournaments:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Eliminar un torneo (y todos sus datos en cascada)
app.delete('/api/tournaments/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM tournaments WHERE id = $1', [id]);
        res.status(204).send();
    } catch (error) {
        console.error('Error deleting tournament:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// --- GESTIÓN DE JUGADORES (POR TORNEO) ---

// Obtener todos los jugadores de un torneo específico
app.get('/api/tournaments/:tournamentId/players', async (req, res) => {
    const { tournamentId } = req.params;
    try {
        const { rows } = await pool.query('SELECT * FROM players WHERE tournament_id = $1 ORDER BY points DESC, name ASC', [tournamentId]);
        res.json(rows);
    } catch (error) {
        console.error(`Error fetching players for tournament ${tournamentId}:`, error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Añadir un nuevo jugador a un torneo
app.post('/api/tournaments/:tournamentId/players', async (req, res) => {
    const { tournamentId } = req.params;
    const { name, grade, school } = req.body;
    if (!name || !grade || !school) {
        return res.status(400).json({ error: 'Nombre, grado y escuela son requeridos.' });
    }
    try {
        const { rows } = await pool.query(
            'INSERT INTO players (tournament_id, name, grade, school) VALUES ($1, $2, $3, $4) RETURNING *',
            [tournamentId, name, grade, school]
        );
        res.status(201).json(rows[0]);
    } catch (error) {
        if (error.code === '23505') { // Error de clave única (jugador duplicado)
            return res.status(409).json({ error: `El jugador "${name}" ya existe en este torneo.` });
        }
        console.error('Error adding player:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Importar jugadores en lote a un torneo
app.post('/api/tournaments/:tournamentId/players/bulk', async (req, res) => {
    const { tournamentId } = req.params;
    const { players: newPlayers } = req.body;
    if (!Array.isArray(newPlayers) || newPlayers.length === 0) {
        return res.status(400).json({ error: 'Se requiere un array de jugadores.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: existingPlayers } = await client.query('SELECT name FROM players WHERE tournament_id = $1', [tournamentId]);
        const existingNames = new Set(existingPlayers.map(p => p.name.toLowerCase()));
        
        let importedCount = 0;
        let duplicatesCount = 0;

        for (const player of newPlayers) {
            if (existingNames.has(player.name.toLowerCase())) {
                duplicatesCount++;
                continue;
            }
            await client.query(
                'INSERT INTO players (tournament_id, name, grade, school) VALUES ($1, $2, $3, $4)',
                [tournamentId, player.name, player.grade, player.school]
            );
            existingNames.add(player.name.toLowerCase());
            importedCount++;
        }

        await client.query('COMMIT');
        res.status(201).json({ importedCount, duplicatesCount });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error in bulk import:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
        client.release();
    }
});

// Eliminar un jugador
app.delete('/api/players/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM players WHERE id = $1', [id]);
        res.status(204).send();
    } catch (error) {
        console.error('Error deleting player:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// --- GESTIÓN DE EMPAREJAMIENTOS (POR TORNEO) ---

// Obtener todos los emparejamientos de un torneo
app.get('/api/tournaments/:tournamentId/pairings', async (req, res) => {
    const { tournamentId } = req.params;
    try {
        const { rows } = await pool.query(`
            SELECT 
                p.id, p.round_number, p.result,
                pw.id as white_id, pw.name as white_name,
                pb.id as black_id, pb.name as black_name
            FROM pairings p
            LEFT JOIN players pw ON p.white_player_id = pw.id
            LEFT JOIN players pb ON p.black_player_id = pb.id
            WHERE p.tournament_id = $1
            ORDER BY p.round_number, p.id
        `, [tournamentId]);
        res.json(rows);
    } catch (error) {
        console.error(`Error fetching pairings for tournament ${tournamentId}:`, error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Generar emparejamientos
app.post('/api/tournaments/:tournamentId/pairings/generate', async (req, res) => {
    const { tournamentId } = req.params;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const roundRes = await client.query('SELECT COALESCE(MAX(round_number), 0) + 1 as new_round FROM pairings WHERE tournament_id = $1', [tournamentId]);
        const currentRound = roundRes.rows[0].new_round;

        const playersRes = await client.query('SELECT * FROM players WHERE tournament_id = $1 ORDER BY points DESC, name ASC', [tournamentId]);
        let players = playersRes.rows;

        const pairingsRes = await client.query('SELECT white_player_id, black_player_id FROM pairings WHERE tournament_id = $1', [tournamentId]);
        const pastOpponents = players.reduce((acc, p) => ({ ...acc, [p.id]: [] }), {});
        pairingsRes.rows.forEach(p => {
            if (p.white_player_id && p.black_player_id) {
                pastOpponents[p.white_player_id].push(p.black_player_id);
                pastOpponents[p.black_player_id].push(p.white_player_id);
            }
        });
        
        const paired = new Set();
        if (players.length % 2 !== 0) {
            let byePlayer = players.slice().reverse().find(p => !p.has_had_bye) || players[players.length - 1];
            paired.add(byePlayer.id);
            await client.query('UPDATE players SET points = points + 1, has_had_bye = TRUE WHERE id = $1', [byePlayer.id]);
            await client.query('INSERT INTO pairings (tournament_id, round_number, white_player_id, result) VALUES ($1, $2, $3, $4)', [tournamentId, currentRound, byePlayer.id, '1-0']);
        }

        const playersToPair = players.filter(p => !paired.has(p.id));
        for (let i = 0; i < playersToPair.length; i++) {
            if (paired.has(playersToPair[i].id)) continue;
            const player1 = playersToPair[i];
            let player2 = null;
            for (let j = i + 1; j < playersToPair.length; j++) {
                const candidate = playersToPair[j];
                if (!paired.has(candidate.id) && !pastOpponents[player1.id].includes(candidate.id)) {
                    player2 = candidate;
                    break;
                }
            }
            if (player2) {
                await client.query('INSERT INTO pairings (tournament_id, round_number, white_player_id, black_player_id) VALUES ($1, $2, $3, $4)', [tournamentId, currentRound, player1.id, player2.id]);
                paired.add(player1.id);
                paired.add(player2.id);
            }
        }
        
        await client.query('COMMIT');
        res.status(201).json({ message: `Emparejamientos para la ronda ${currentRound} generados.` });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error generating pairings:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
        client.release();
    }
});

// Actualizar/Corregir un resultado
app.put('/api/pairings/:id', async (req, res) => {
    const { id } = req.params;
    const { result: newResult } = req.body;
    if (!['1-0', '0-1', '0.5-0.5'].includes(newResult)) {
        return res.status(400).json({ error: 'Resultado inválido.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const pairingRes = await client.query('SELECT * FROM pairings WHERE id = $1', [id]);
        if (pairingRes.rows.length === 0) return res.status(404).json({ error: 'Emparejamiento no encontrado.' });
        
        const pairing = pairingRes.rows[0];
        const oldResult = pairing.result;

        // Revertir puntos del resultado anterior si existía
        if (oldResult) {
            if (oldResult === '1-0') await client.query('UPDATE players SET points = points - 1 WHERE id = $1', [pairing.white_player_id]);
            else if (oldResult === '0-1') await client.query('UPDATE players SET points = points - 1 WHERE id = $1', [pairing.black_player_id]);
            else if (oldResult === '0.5-0.5') {
                await client.query('UPDATE players SET points = points - 0.5 WHERE id = $1', [pairing.white_player_id]);
                await client.query('UPDATE players SET points = points - 0.5 WHERE id = $1', [pairing.black_player_id]);
            }
        }

        // Aplicar nuevos puntos
        if (newResult === '1-0') await client.query('UPDATE players SET points = points + 1 WHERE id = $1', [pairing.white_player_id]);
        else if (newResult === '0-1') await client.query('UPDATE players SET points = points + 1 WHERE id = $1', [pairing.black_player_id]);
        else if (newResult === '0.5-0.5') {
            await client.query('UPDATE players SET points = points + 0.5 WHERE id = $1', [pairing.white_player_id]);
            await client.query('UPDATE players SET points = points + 0.5 WHERE id = $1', [pairing.black_player_id]);
        }
        
        await client.query('UPDATE pairings SET result = $1 WHERE id = $2', [newResult, id]);
        await client.query('COMMIT');
        res.json({ message: 'Resultado actualizado con éxito.' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating result:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
        client.release();
    }
});

// --- EXPORTACIÓN ---

// Exportar clasificación de un torneo a CSV
app.get('/api/tournaments/:tournamentId/export', async (req, res) => {
    const { tournamentId } = req.params;
    try {
        const playersRes = await pool.query('SELECT * FROM players WHERE tournament_id = $1', [tournamentId]);
        const pairingsRes = await pool.query('SELECT * FROM pairings WHERE tournament_id = $1', [tournamentId]);
        const players = playersRes.rows;
        const pairings = pairingsRes.rows;

        const playersWithBuchholz = players.map(player => {
            const playerPairings = pairings.filter(p => p.white_player_id === player.id || p.black_player_id === player.id);
            const opponentIds = playerPairings.map(p => p.white_player_id === player.id ? p.black_player_id : p.white_player_id).filter(Boolean);
            const buchholz = opponentIds.reduce((sum, oppId) => {
                const opponent = players.find(p => p.id === oppId);
                return sum + (opponent ? parseFloat(opponent.points) : 0);
            }, 0);
            return { ...player, buchholz, games_played: opponentIds.length };
        }).sort((a,b) => b.points - a.points || b.buchholz - a.buchholz);

        const dataToExport = playersWithBuchholz.map((p, index) => ({
            Pos: index + 1,
            Jugador: p.name,
            Grado: p.grade,
            Escuela: p.school,
            Puntos: parseFloat(p.points),
            Buchholz: p.buchholz.toFixed(1),
            Partidas: p.games_played
        }));

        const csv = Papa.unparse(dataToExport);
        res.header('Content-Type', 'text/csv');
        res.attachment(`clasificacion-torneo-${tournamentId}.csv`);
        res.send(csv);

    } catch (error) {
        console.error('Error exporting data:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Iniciar el servidor
app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});

