import express from 'express';
import serverless from 'serverless-http';
import cors from 'cors';
import pg from 'pg';
import papaparse from 'papaparse';

// --- LÓGICA DE CONEXIÓN A LA BASE DE DATOS ---
// Esta lógica se ejecuta una sola vez cuando la función se "despierta".
let pool;
try {
    pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
    });
    console.log("¡Conexión a la base de datos Neon establecida exitosamente!");
} catch (error) {
    console.error("Error al conectar con la base de datos Neon:", error);
}
// --- FIN DE LA LÓGICA DE CONEXIÓN ---


const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// Middleware para registrar la ruta real que recibe la función
app.use((req, res, next) => {
    // req.path nos dirá qué ruta ve la función DESPUÉS de la reescritura de Netlify
    console.log(`Petición recibida en la ruta interna: ${req.path}`);
    next();
});

// Usamos un router para anidar todas nuestras rutas.
// Netlify reescribe /api/* a /*, por lo que nuestro router debe manejar las rutas sin el prefijo /api.
const router = express.Router();


// --- RUTAS DE LA API (COMPLETAS) ---

// OBTENER TODOS LOS TORNEOS
router.get('/tournaments', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM tournaments ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// CREAR UN NUEVO TORNEO
router.post('/tournaments', async (req, res) => {
    try {
        const { name } = req.body;
        const result = await pool.query('INSERT INTO tournaments (name) VALUES ($1) RETURNING *', [name]);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ELIMINAR UN TORNEO
router.delete('/tournaments/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM tournaments WHERE id = $1', [id]);
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// OBTENER JUGADORES DE UN TORNEO
router.get('/tournaments/:tournamentId/players', async (req, res) => {
    try {
        const { tournamentId } = req.params;
        const result = await pool.query('SELECT * FROM players WHERE tournament_id = $1 ORDER BY name', [tournamentId]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// AÑADIR UN JUGADOR A UN TORNEO
router.post('/tournaments/:tournamentId/players', async (req, res) => {
    try {
        const { tournamentId } = req.params;
        const { name, grade, school } = req.body;

        const existingPlayer = await pool.query('SELECT * FROM players WHERE tournament_id = $1 AND lower(name) = lower($2)', [tournamentId, name]);
        if (existingPlayer.rows.length > 0) {
            return res.status(409).json({ error: 'Este jugador ya está registrado en el torneo.' });
        }

        const result = await pool.query(
            'INSERT INTO players (tournament_id, name, grade, school) VALUES ($1, $2, $3, $4) RETURNING *',
            [tournamentId, name, grade, school]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// IMPORTAR JUGADORES EN MASA
router.post('/tournaments/:tournamentId/players/bulk', async (req, res) => {
    const { tournamentId } = req.params;
    const { players } = req.body;
    let importedCount = 0;
    let duplicatesCount = 0;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const player of players) {
            const existing = await client.query('SELECT id FROM players WHERE tournament_id = $1 AND lower(name) = lower($2)', [tournamentId, player.name]);
            if (existing.rows.length === 0) {
                await client.query('INSERT INTO players (tournament_id, name, grade, school) VALUES ($1, $2, $3, $4)', [tournamentId, player.name, player.grade, player.school]);
                importedCount++;
            } else {
                duplicatesCount++;
            }
        }
        await client.query('COMMIT');
        res.status(201).json({ importedCount, duplicatesCount });
    } catch (e) {
        await client.query('ROLLBACK');
        console.error(e);
        res.status(500).json({ error: 'Error en la transacción de importación' });
    } finally {
        client.release();
    }
});


// ELIMINAR UN JUGADOR
router.delete('/players/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM players WHERE id = $1', [id]);
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// OBTENER EMPAREJAMIENTOS DE UN TORNEO
router.get('/tournaments/:tournamentId/pairings', async (req, res) => {
    try {
        const { tournamentId } = req.params;
        const result = await pool.query(`
            SELECT 
                p.id, p.round_number, p.result,
                wp.name as white_name, bp.name as black_name,
                p.white_id, p.black_id
            FROM pairings p
            JOIN players wp ON p.white_id = wp.id
            LEFT JOIN players bp ON p.black_id = bp.id
            WHERE p.tournament_id = $1
            ORDER BY p.round_number, p.id;
        `, [tournamentId]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// GENERAR NUEVOS EMPAREJAMIENTOS
router.post('/tournaments/:tournamentId/pairings/generate', async (req, res) => {
    const { tournamentId } = req.params;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        const playersResult = await client.query('SELECT * FROM players WHERE tournament_id = $1 ORDER BY points DESC, name ASC', [tournamentId]);
        let players = playersResult.rows;
        
        const lastRoundResult = await client.query('SELECT MAX(round_number) as max_round FROM pairings WHERE tournament_id = $1', [tournamentId]);
        const currentRound = (lastRoundResult.rows[0].max_round || 0) + 1;

        let pairedIds = new Set();
        
        // Manejar Bye (jugador impar)
        if (players.length % 2 !== 0) {
            let byePlayer = null;
            // Buscar jugador con menos puntos que no haya tenido bye
            for (let i = players.length - 1; i >= 0; i--) {
                const p = players[i];
                const byeResult = await client.query('SELECT id FROM pairings WHERE (white_id = $1 OR black_id = $1) AND black_id IS NULL AND tournament_id = $2', [p.id, tournamentId]);
                if (byeResult.rows.length === 0) {
                    byePlayer = p;
                    break;
                }
            }
             // Si todos los de menor puntaje ya tuvieron bye, se asigna a uno de ellos.
            if (!byePlayer) byePlayer = players[players.length - 1];

            // Asignar bye
            await client.query('INSERT INTO pairings (tournament_id, round_number, white_id, result) VALUES ($1, $2, $3, $4)', [tournamentId, currentRound, byePlayer.id, '1-0']);
            await client.query('UPDATE players SET points = points + 1 WHERE id = $1', [byePlayer.id]);
            pairedIds.add(byePlayer.id);
        }

        players = players.filter(p => !pairedIds.has(p.id));

        for (let i = 0; i < players.length; i++) {
            if (pairedIds.has(players[i].id)) continue;

            const player1 = players[i];
            let player2 = null;

            for (let j = i + 1; j < players.length; j++) {
                const candidate = players[j];
                if (pairedIds.has(candidate.id)) continue;
                
                const prevGame = await client.query('SELECT id FROM pairings WHERE (white_id = $1 AND black_id = $2) OR (white_id = $2 AND black_id = $1)', [player1.id, candidate.id]);
                if (prevGame.rows.length === 0) {
                    player2 = candidate;
                    break;
                }
            }
             // Si no se encuentra oponente que no haya jugado, se toma el siguiente disponible
            if (!player2) {
                for (let j = i + 1; j < players.length; j++) {
                    if (!pairedIds.has(players[j].id)) {
                        player2 = players[j];
                        break;
                    }
                }
            }

            if (player2) {
                await client.query('INSERT INTO pairings (tournament_id, round_number, white_id, black_id) VALUES ($1, $2, $3, $4)', [tournamentId, currentRound, player1.id, player2.id]);
                pairedIds.add(player1.id);
                pairedIds.add(player2.id);
            }
        }
        
        await client.query('COMMIT');
        res.status(201).json({ message: `Emparejamientos para la ronda ${currentRound} generados.` });
    } catch (e) {
        await client.query('ROLLBACK');
        console.error(e);
        res.status(500).json({ error: 'Error generando emparejamientos' });
    } finally {
        client.release();
    }
});


// ACTUALIZAR RESULTADO DE UN EMPAREJAMIENTO
router.put('/pairings/:id', async (req, res) => {
    const { id } = req.params;
    const { result } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        
        const pairing = (await client.query('SELECT * FROM pairings WHERE id = $1', [id])).rows[0];
        if (!pairing) return res.status(404).json({error: "Emparejamiento no encontrado"});

        const { white_id, black_id, result: old_result } = pairing;

        // Anular puntos de resultado anterior si existía
        if (old_result) {
            if (old_result === '1-0') await client.query('UPDATE players SET points = points - 1 WHERE id = $1', [white_id]);
            if (old_result === '0-1') await client.query('UPDATE players SET points = points - 1 WHERE id = $1', [black_id]);
            if (old_result === '0.5-0.5') {
                await client.query('UPDATE players SET points = points - 0.5 WHERE id = $1', [white_id]);
                await client.query('UPDATE players SET points = points - 0.5 WHERE id = $1', [black_id]);
            }
        }

        // Aplicar nuevos puntos
        if (result === '1-0') await client.query('UPDATE players SET points = points + 1 WHERE id = $1', [white_id]);
        if (result === '0-1') await client.query('UPDATE players SET points = points + 1 WHERE id = $1', [black_id]);
        if (result === '0.5-0.5') {
            await client.query('UPDATE players SET points = points + 0.5 WHERE id = $1', [white_id]);
            await client.query('UPDATE players SET points = points + 0.5 WHERE id = $1', [black_id]);
        }
        
        await client.query('UPDATE pairings SET result = $1 WHERE id = $2', [result, id]);
        
        await client.query('COMMIT');
        res.status(200).json({ message: 'Resultado actualizado' });
    } catch (e) {
        await client.query('ROLLBACK');
        console.error(e);
        res.status(500).json({ error: 'Error actualizando resultado' });
    } finally {
        client.release();
    }
});

// EXPORTAR CLASIFICACIÓN A CSV
router.get('/tournaments/:tournamentId/export', async (req, res) => {
    try {
        const { tournamentId } = req.params;
        const playersResult = await pool.query('SELECT * FROM players WHERE tournament_id = $1', [tournamentId]);
        const players = playersResult.rows;
        
        const pairingsResult = await pool.query('SELECT * FROM pairings WHERE tournament_id = $1', [tournamentId]);
        const pairings = pairingsResult.rows;
        
        const standings = players.map(player => {
            const playerPairings = pairings.filter(p => p.white_id === player.id || p.black_id === player.id);
            const opponentIds = playerPairings.map(p => p.white_id === player.id ? p.black_id : p.white_id).filter(Boolean);
            const buchholz = opponentIds.reduce((sum, oppId) => {
                const opponent = players.find(p => p.id === oppId);
                return sum + (opponent ? parseFloat(opponent.points) : 0);
            }, 0);
            return {
                Nombre: player.name,
                Escuela: player.school,
                Grado: player.grade,
                Puntos: parseFloat(player.points).toFixed(1),
                Buchholz: buchholz.toFixed(1),
                Partidas: opponentIds.length,
            };
        }).sort((a,b) => b.Puntos - a.Puntos || b.Buchholz - a.Buchholz);

        const csv = papaparse.unparse(standings);
        res.header('Content-Type', 'text/csv');
        res.attachment('clasificacion.csv');
        res.send(csv);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al exportar los datos' });
    }
});


// --- FINALIZACIÓN DE LA CONFIGURACIÓN ---

// Usamos el router en la ruta base.
// ESTA ES LA CONFIGURACIÓN CORRECTA:
// Netlify reescribe /api/* a /*, por lo que el router de Express no debe esperar el prefijo /api.
app.use('/', router);

// ¡ESTA ES LA LÍNEA MÁS IMPORTANTE!
// Crea y exporta la "manija" llamada "handler" que Netlify necesita.
export const handler = serverless(app);

