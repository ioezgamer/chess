// Importar módulos
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Papa from 'papaparse';
import pg from 'pg'; // Usamos 'pg' directamente
import serverless from 'serverless-http';

dotenv.config();

// --- LÓGICA DE CONEXIÓN A LA BASE DE DATOS (antes en db.js) ---
// Extraemos el Pool de 'pg'
const { Pool } = pg;

// Creamos la conexión a la base de datos usando la variable de entorno
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Verificamos la conexión
pool.connect((err, client, release) => {
    if (err) {
        return console.error('Error adquiriendo cliente para la base de datos', err.stack);
    }
    console.log('¡Conexión a la base de datos Neon establecida exitosamente!');
    client.release();
});
// --- FIN DE LA LÓGICA DE CONEXIÓN ---


const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// Creamos un router para anidar todas nuestras rutas bajo /api
const router = express.Router();

// --- RUTAS DE LA API (COMPLETAS) ---

// -- Torneos --
router.get('/tournaments', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM tournaments ORDER BY created_at DESC');
        res.json(rows);
    } catch (error) {
        console.error('Error fetching tournaments:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.post('/tournaments', async (req, res) => {
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

router.delete('/tournaments/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM tournaments WHERE id = $1', [id]);
        res.status(204).send();
    } catch (error) {
        console.error('Error deleting tournament:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// -- Jugadores --
router.get('/tournaments/:tournamentId/players', async (req, res) => {
    const { tournamentId } = req.params;
    try {
        const { rows } = await pool.query('SELECT * FROM players WHERE tournament_id = $1 ORDER BY name', [tournamentId]);
        res.json(rows);
    } catch (error) {
        console.error('Error fetching players:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.post('/tournaments/:tournamentId/players', async (req, res) => {
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
         if (error.code === '23505') { // Unique constraint violation
            return res.status(409).json({ error: `El jugador "${name}" ya existe en este torneo.` });
        }
        console.error('Error adding player:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.post('/tournaments/:tournamentId/players/bulk', async (req, res) => {
    const { tournamentId } = req.params;
    const { players } = req.body;
    let importedCount = 0;
    let duplicatesCount = 0;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const player of players) {
            try {
                await client.query(
                    'INSERT INTO players (tournament_id, name, grade, school) VALUES ($1, $2, $3, $4)',
                    [tournamentId, player.name, player.grade, player.school]
                );
                importedCount++;
            } catch (error) {
                if (error.code === '23505') {
                    duplicatesCount++;
                } else {
                    throw error;
                }
            }
        }
        await client.query('COMMIT');
        res.json({ importedCount, duplicatesCount });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error bulk inserting players:', error);
        res.status(500).json({ error: 'Error en la importación masiva.' });
    } finally {
        client.release();
    }
});

router.delete('/players/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM players WHERE id = $1', [id]);
        res.status(204).send();
    } catch (error) {
        console.error('Error deleting player:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// -- Emparejamientos y Resultados --
router.get('/tournaments/:tournamentId/pairings', async (req, res) => {
    const { tournamentId } = req.params;
    try {
        const { rows } = await pool.query(`
            SELECT 
                p.id, p.round_number, p.result,
                p.white_id, p.black_id,
                wp.name as white_name,
                bp.name as black_name
            FROM pairings p
            LEFT JOIN players wp ON p.white_id = wp.id
            LEFT JOIN players bp ON p.black_id = bp.id
            WHERE p.tournament_id = $1
            ORDER BY p.round_number, p.id;
        `, [tournamentId]);
        res.json(rows);
    } catch (error) {
        console.error('Error fetching pairings:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.post('/tournaments/:tournamentId/pairings/generate', async (req, res) => {
    const { tournamentId } = req.params;
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const playersResult = await client.query('SELECT * FROM players WHERE tournament_id = $1', [tournamentId]);
        let players = playersResult.rows;

        if (players.length < 2) {
            return res.status(400).json({ error: 'Se necesitan al menos 2 jugadores.' });
        }

        const pairingsResult = await client.query('SELECT * FROM pairings WHERE tournament_id = $1', [tournamentId]);
        const allPairings = pairingsResult.rows;
        
        const currentRound = allPairings.length > 0 ? Math.max(...allPairings.map(p => p.round_number)) + 1 : 1;

        players.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));

        let availablePlayers = [...players];
        const newPairings = [];
        
        if (availablePlayers.length % 2 !== 0) {
            const byePlayers = players.filter(p => p.had_bye);
            let playerToBye = availablePlayers.filter(p => !p.had_bye).sort((a, b) => a.points - b.points)[0];
            if (!playerToBye) {
                playerToBye = availablePlayers.sort((a, b) => a.points - b.points)[0];
            }
            
            await client.query('UPDATE players SET points = points + 1, had_bye = TRUE WHERE id = $1', [playerToBye.id]);
            newPairings.push({ white_id: playerToBye.id, black_id: null, result: '1-0' });
            availablePlayers = availablePlayers.filter(p => p.id !== playerToBye.id);
        }

        const pairedIds = new Set();
        for (const player1 of availablePlayers) {
            if (pairedIds.has(player1.id)) continue;
            
            let opponent = null;
            for (const player2 of availablePlayers) {
                if (player1.id === player2.id || pairedIds.has(player2.id)) continue;

                const havePlayed = allPairings.some(p =>
                    (p.white_id === player1.id && p.black_id === player2.id) ||
                    (p.white_id === player2.id && p.black_id === player1.id)
                );
                
                if (!havePlayed) {
                    opponent = player2;
                    break;
                }
            }
            if (!opponent) { // Fallback if all have played
                opponent = availablePlayers.find(p => p.id !== player1.id && !pairedIds.has(p.id));
            }

            if (opponent) {
                newPairings.push({ white_id: player1.id, black_id: opponent.id, result: null });
                pairedIds.add(player1.id);
                pairedIds.add(opponent.id);
            }
        }
        
        for (const p of newPairings) {
            await client.query(
                'INSERT INTO pairings (tournament_id, round_number, white_id, black_id, result) VALUES ($1, $2, $3, $4, $5)',
                [tournamentId, currentRound, p.white_id, p.black_id, p.result]
            );
        }
        
        await client.query('COMMIT');
        res.status(201).json({ message: `Ronda ${currentRound} generada.` });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error generating pairings:', error);
        res.status(500).json({ error: 'Error interno del servidor al generar emparejamientos.' });
    } finally {
        client.release();
    }
});

router.put('/pairings/:id', async (req, res) => {
    const { id } = req.params;
    const { result } = req.body;
    
    if (!['1-0', '0-1', '0.5-0.5'].includes(result)) {
        return res.status(400).json({ error: 'Resultado no válido.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const pairingRes = await client.query('SELECT * FROM pairings WHERE id = $1', [id]);
        if (pairingRes.rows.length === 0) throw new Error('Emparejamiento no encontrado.');
        
        const pairing = pairingRes.rows[0];
        
        // Revertir puntos antiguos si existían
        if (pairing.result) {
            let oldWhitePoints = 0, oldBlackPoints = 0;
            if (pairing.result === '1-0') oldWhitePoints = 1;
            else if (pairing.result === '0-1') oldBlackPoints = 1;
            else if (pairing.result === '0.5-0.5') { oldWhitePoints = 0.5; oldBlackPoints = 0.5; }
            await client.query('UPDATE players SET points = points - $1 WHERE id = $2', [oldWhitePoints, pairing.white_id]);
            await client.query('UPDATE players SET points = points - $1 WHERE id = $2', [oldBlackPoints, pairing.black_id]);
        }
        
        // Aplicar nuevos puntos
        let newWhitePoints = 0, newBlackPoints = 0;
        if (result === '1-0') newWhitePoints = 1;
        else if (result === '0-1') newBlackPoints = 1;
        else if (result === '0.5-0.5') { newWhitePoints = 0.5; newBlackPoints = 0.5; }
        
        await client.query('UPDATE players SET points = points + $1 WHERE id = $2', [newWhitePoints, pairing.white_id]);
        await client.query('UPDATE players SET points = points + $1 WHERE id = $2', [newBlackPoints, pairing.black_id]);
        
        await client.query('UPDATE pairings SET result = $1 WHERE id = $2', [result, id]);
        
        await client.query('COMMIT');
        res.json({ message: 'Resultado actualizado.' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating result:', error);
        res.status(500).json({ error: 'Error al actualizar el resultado.' });
    } finally {
        client.release();
    }
});

// -- Exportación --
router.get('/tournaments/:tournamentId/export', async (req, res) => {
    const { tournamentId } = req.params;
    try {
        const playersRes = await pool.query('SELECT * FROM players WHERE tournament_id = $1', [tournamentId]);
        const players = playersRes.rows;
        const pairingsRes = await pool.query('SELECT * FROM pairings WHERE tournament_id = $1', [tournamentId]);
        const pairings = pairingsRes.rows;

        const standings = players.map(player => {
            const playerPairings = pairings.filter(p => p.white_id === player.id || p.black_id === player.id);
            const opponentIds = playerPairings.map(p => p.white_id === player.id ? p.black_id : p.white_id).filter(Boolean);
            const buchholz = opponentIds.reduce((sum, oppId) => {
                const opponent = players.find(p => p.id === oppId);
                return sum + (opponent ? parseFloat(opponent.points) : 0);
            }, 0);
            return {
                Nombre: player.name,
                Puntos: parseFloat(player.points).toFixed(1),
                Buchholz: buchholz.toFixed(1),
                Partidas: opponentIds.length,
                Grado: player.grade,
                Escuela: player.school
            };
        }).sort((a,b) => b.Puntos - a.Puntos || b.Buchholz - a.Buchholz);

        const csv = Papa.unparse(standings.map((p, i) => ({ Pos: i + 1, ...p })));
        
        res.header('Content-Type', 'text/csv');
        res.attachment('clasificacion.csv');
        res.send(csv);

    } catch (error) {
        console.error('Error exporting standings:', error);
        res.status(500).json({ error: 'Error al exportar.' });
    }
});


// --- FINALIZACIÓN DE LA CONFIGURACIÓN ---

// Usamos el router en la ruta base /api
app.use('/api', router);

// ¡ESTA ES LA LÍNEA MÁS IMPORTANTE!
// Crea y exporta la "manija" llamada "handler" que Netlify necesita.
export const handler = serverless(app);

