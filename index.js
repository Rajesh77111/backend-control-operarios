// index.js
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware para que acepte JSON y permita peticiones desde tu página
app.use(express.json());
app.use(cors());

// 1. Conexión a MongoDB Atlas
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Conectado a MongoDB Atlas'))
  .catch((err) => console.error('❌ Error al conectar a MongoDB:', err));

// 2. Definir el modelo (cómo se guarda un registro de operario)
const registroSchema = new mongoose.Schema({
  nombreOperario: { type: String, required: true },
  tipo: { type: String, enum: ['ingreso', 'salida'], required: true },
  lat: Number,
  lng: Number,
  dentroZona: Boolean,
  creadoEn: { type: Date, default: Date.now },
});

const Registro = mongoose.model('Registro', registroSchema);

// 3. Función para calcular distancia entre dos puntos (en metros)
function distanciaMetros(lat1, lng1, lat2, lng2) {
  const R = 6371000; // radio de la Tierra en metros
  const toRad = (grado) => (grado * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

// 4. Ruta para registrar ingreso o salida
app.post('/api/registro', async (req, res) => {
  try {
    const { nombreOperario, tipo, lat, lng } = req.body;

    if (!nombreOperario || !tipo) {
      return res.status(400).json({ mensaje: 'Faltan datos obligatorios' });
    }

    // Si no hay coordenadas, marcamos que está fuera de la zona
    let dentroZona = false;
    let distancia = null;

    if (lat != null && lng != null) {
      const ZONA_LAT = parseFloat(process.env.ZONA_LAT);
      const ZONA_LNG = parseFloat(process.env.ZONA_LNG);
      const ZONA_RADIO_METROS = parseFloat(process.env.ZONA_RADIO_METROS || '200'); // 200m por defecto

      distancia = distanciaMetros(lat, lng, ZONA_LAT, ZONA_LNG);
      dentroZona = distancia <= ZONA_RADIO_METROS;
    }

    // Si quieres bloquear registros fuera de la planta, descomenta esto:
    /*
    if (!dentroZona) {
      return res.status(403).json({
        mensaje: 'No estás dentro de la zona de trabajo autorizada',
        distancia,
      });
    }
    */

    // Guardamos el registro con la hora del servidor
    const nuevoRegistro = new Registro({
      nombreOperario,
      tipo,
      lat,
      lng,
      dentroZona,
    });

    await nuevoRegistro.save();

    res.json({
      mensaje: 'Registro guardado correctamente',
      dentroZona,
      distancia,
      registro: nuevoRegistro,
    });
  } catch (error) {
    console.error('Error al guardar registro:', error);
    res.status(500).json({ mensaje: 'Error en el servidor' });
  }
});

// 5. Ruta para ver registros (por ahora simple)
app.get('/api/registros', async (req, res) => {
  const registros = await Registro.find().sort({ creadoEn: -1 }).limit(100);
  res.json(registros);
});

// 6. Iniciar el servidor
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
});
