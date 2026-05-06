// backend-AgenteX/config/supabase.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY; 

if (!supabaseUrl || !supabaseKey) {
    console.error("ALERTA: Faltan credenciales de Supabase en el archivo .env");
    process.exit(1); 
}

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;