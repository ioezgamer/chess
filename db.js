import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// Se conecta a la base de datos Neon usando la URL de conexión
// que provee Neon en su dashboard.
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

pool.on('connect', () => {
    console.log('🔌 Conectado a la base de datos Neon!');
});

export default pool;
