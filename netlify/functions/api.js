import express from 'express';
import serverless from 'serverless-http';
import cors from 'cors';
import pg from 'pg';
import papaparse from 'papaparse';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { SwissPairing } from 'swiss-pairing';

// --- CONFIGURACIÓN Y CONEXIÓN A BD ---
let pool;
try {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    console.log("¡Conexión a la base de datos Neon establecida exitosamente!");
} catch (error) {
    console.error("Error al conectar con la base de datos Neon:", error);
}

const JWT_SECRET = process.env.JWT_SECRET;
const app = express();
const router = express.Router();

app.use(cors());
app.use(express.json());

// --- MIDDLEWARE DE AUTENTICACIÓN ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

// --- RUTAS DE AUTENTICACIÓN ---
router.post('/register', async (req, res) => {
    try {
        const { email, password } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = await pool.query(
            "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email",
            [email, hashedPassword]
        );
        res.status(201).json(newUser.rows[0]);
    } catch (error) {
        console.error('Error en el registro:', error);
        res.status(500).json({ error: "El correo electrónico ya está en uso." });
    }
});

router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const userResult = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
        if (userResult.rows.length === 0) {
            return res.status(400).json({ error: "Email o contraseña incorrectos." });
        }
        const user = userResult.rows[0];
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
            return res.status(400).json({ error: "Email o contraseña incorrectos." });
        }
        const accessToken = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '1d' });
        res.json({ accessToken });
    } catch (error) {
        console.error('Error en el inicio de sesión:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// --- RUTAS PROTEGIDAS (TORNEOS) ---
router.get('/tournaments', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM tournaments WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.post('/tournaments', authenticateToken, async (req, res) => {
    try {
        const { name } = req.body;
        const result = await pool.query('INSERT INTO tournaments (name, user_id) VALUES ($1, $2) RETURNING *', [name, req.user.id]);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.delete('/tournaments/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        // Verificar que el torneo pertenece al usuario
        await pool.query('DELETE FROM tournaments WHERE id = $1 AND user_id = $2', [id, req.user.id]);
        res.status(204).send();
    } catch (err) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// --- RUTAS DE JUGADORES Y EMPAREJAMIENTOS (PROTEGIDAS) ---
// (Similar a las anteriores, pero añadiendo `authenticateToken` y `user_id` en las queries)

router.get('/tournaments/:tournamentId/players', authenticateToken, async (req, res) => {
    const { tournamentId } = req.params;
    const result = await pool.query('SELECT * FROM players WHERE tournament_id = $1 ORDER BY name', [tournamentId]);
    res.json(result.rows);
});

router.post('/tournaments/:tournamentId/players', authenticateToken, async (req, res) => {
    const { tournamentId } = req.params;
    const { name, grade, school } = req.body;
    const result = await pool.query(
        'INSERT INTO players (tournament_id, name, grade, school) VALUES ($1, $2, $3, $4) RETURNING *',
        [tournamentId, name, grade, school]
    );
    res.status(201).json(result.rows[0]);
});

router.post('/tournaments/:tournamentId/players/bulk', authenticateToken, async (req, res) => {
    const { tournamentId } = req.params;
    const { players } = req.body;
    let importedCount = 0, duplicatesCount = 0;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const player of players) {
            const existing = await client.query('SELECT id FROM players WHERE tournament_id = $1 AND lower(name) = lower($2)', [tournamentId, player.name]);
            if (existing.rows.length === 0) {
                await client.query('INSERT INTO players (tournament_id, name, grade, school) VALUES ($1, $2, $3, $4)', [tournamentId, player.name, player.grade, player.school]);
                importedCount++;
            } else { duplicatesCount++; }
        }
        await client.query('COMMIT');
        res.status(201).json({ importedCount, duplicatesCount });
    } catch (e) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Error en la transacción de importación' });
    } finally {
        client.release();
    }
});

router.delete('/players/:id', authenticateToken, async (req, res) => {
    await pool.query('DELETE FROM players WHERE id = $1', [req.params.id]);
    res.status(204).send();
});

router.get('/tournaments/:tournamentId/pairings', authenticateToken, async (req, res) => {
    const { tournamentId } = req.params;
    const result = await pool.query(`
        SELECT p.id, p.round_number, p.result, wp.name as white_name, bp.name as black_name, p.white_id, p.black_id
        FROM pairings p
        JOIN players wp ON p.white_id = wp.id
        LEFT JOIN players bp ON p.black_id = bp.id
        WHERE p.tournament_id = $1 ORDER BY p.round_number, p.id;
    `, [tournamentId]);
    res.json(result.rows);
});

router.post('/tournaments/:tournamentId/pairings/generate', authenticateToken, async (req, res) => {
    const { tournamentId } = req.params;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const playersResult = await client.query('SELECT id, name, points, has_had_bye FROM players WHERE tournament_id = $1', [tournamentId]);
        let tournamentPlayers = playersResult.rows;

        const historyResult = await client.query('SELECT white_id, black_id FROM pairings WHERE tournament_id = $1', [tournamentId]);
        const history = historyResult.rows.map(r => [r.white_id, r.black_id].sort().toString());

        const pairingOptions = {
            maxBye: 1,
            getAvoidPaired: (p) => history.filter(h => h.includes(p.id)).map(h => h.replace(p.id, '').replace(',', '')).map(Number),
        };

        const pairings = SwissPairing(tournamentPlayers, pairingOptions);
        
        const lastRoundResult = await client.query('SELECT MAX(round_number) as max_round FROM pairings WHERE tournament_id = $1', [tournamentId]);
        const currentRound = (lastRoundResult.rows[0].max_round || 0) + 1;

        for (const pair of pairings) {
            if (pair.player2) {
                await client.query('INSERT INTO pairings (tournament_id, round_number, white_id, black_id) VALUES ($1, $2, $3, $4)', [tournamentId, currentRound, pair.player1.id, pair.player2.id]);
            } else { // Jugador con BYE
                await client.query('INSERT INTO pairings (tournament_id, round_number, white_id, result) VALUES ($1, $2, $3, $4)', [tournamentId, currentRound, pair.player1.id, '1-0']);
                await client.query('UPDATE players SET points = points + 1, has_had_bye = TRUE WHERE id = $1', [pair.player1.id]);
            }
        }
        await client.query('UPDATE tournaments SET current_round = $1 WHERE id = $2', [currentRound, tournamentId]);
        await client.query('COMMIT');
        res.status(201).json({ message: `Emparejamientos para la ronda ${currentRound} generados.` });
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('Error generando pairings:', e);
        res.status(500).json({ error: 'Error generando emparejamientos' });
    } finally {
        client.release();
    }
});

router.put('/pairings/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const { result } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const pairing = (await client.query('SELECT * FROM pairings WHERE id = $1', [id])).rows[0];
        if (!pairing) return res.status(404).json({error: "Emparejamiento no encontrado"});
        
        const { white_id, black_id, result: old_result } = pairing;
        
        // Anular puntos
        if (old_result) {
            if (old_result === '1-0') await client.query('UPDATE players SET points = points - 1 WHERE id = $1', [white_id]);
            if (old_result === '0-1') await client.query('UPDATE players SET points = points - 1 WHERE id = $1', [black_id]);
            if (old_result === '0.5-0.5') {
                await client.query('UPDATE players SET points = points - 0.5 WHERE id = ANY($1::int[])', [[white_id, black_id]]);
            }
        }
        // Aplicar nuevos puntos
        if (result === '1-0') await client.query('UPDATE players SET points = points + 1 WHERE id = $1', [white_id]);
        if (result === '0-1') await client.query('UPDATE players SET points = points + 1 WHERE id = $1', [black_id]);
        if (result === '0.5-0.5') {
            await client.query('UPDATE players SET points = points + 0.5 WHERE id = ANY($1::int[])', [[white_id, black_id]]);
        }
        await client.query('UPDATE pairings SET result = $1 WHERE id = $2', [result, id]);
        await client.query('COMMIT');
        res.status(200).json({ message: 'Resultado actualizado' });
    } catch (e) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Error actualizando resultado' });
    } finally {
        client.release();
    }
});

router.get('/tournaments/:tournamentId/export', authenticateToken, async (req, res) => {
    const { tournamentId } = req.params;
    const players = (await pool.query('SELECT * FROM players WHERE tournament_id = $1', [tournamentId])).rows;
    const pairings = (await pool.query('SELECT * FROM pairings WHERE tournament_id = $1', [tournamentId])).rows;
    // ... (Lógica de cálculo de Buchholz y creación de CSV, igual a la anterior)
    const standings = players.map(player => {
            const playerPairings = pairings.filter(p => p.white_id === player.id || p.black_id === player.id);
            const opponentIds = playerPairings.map(p => p.white_id === player.id ? p.black_id : p.white_id).filter(Boolean);
            const buchholz = opponentIds.reduce((sum, oppId) => {
                const opponent = players.find(p => p.id === oppId);
                return sum + (opponent ? parseFloat(opponent.points) : 0);
            }, 0);
            return {
                Nombre: player.name, Escuela: player.school, Grado: player.grade,
                Puntos: parseFloat(player.points).toFixed(1), Buchholz: buchholz.toFixed(1),
                Partidas: opponentIds.length,
            };
        }).sort((a,b) => b.Puntos - a.Puntos || b.Buchholz - a.Buchholz);

    const csv = papaparse.unparse(standings);
    res.header('Content-Type', 'text/csv');
    res.attachment('clasificacion.csv');
    res.send(csv);
});

// --- FINALIZACIÓN DE LA CONFIGURACIÓN ---
app.use('/api', router);
export const handler = serverless(app);

