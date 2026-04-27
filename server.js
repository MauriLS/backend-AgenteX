const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// 1. Inicializar el cliente de Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// 2. Ruta de prueba (Health Check)
app.get('/api/health', async (req, res) => {
    // Hacemos una consulta a una tabla para validar que los permisos funcionan
    const { data, error } = await supabase.from('users').select('*').limit(1);
    
    if (error) {
        return res.status(500).json({ status: 'Error de conexión', detalle: error.message });
    }
    res.json({ status: 'Supabase conectado correctamente 🚀', data });
});

app.listen(PORT, () => {
    console.log(`Servidor de Agente X corriendo en el puerto ${PORT}`);
});