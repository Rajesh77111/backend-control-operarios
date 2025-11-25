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
  fechaDia: { type: String }, // ej: "2025-11-24"
});

// Antes de guardar, rellenamos fechaDia con YYYY-MM-DD (hora local)
registroSchema.pre('save', function (next) {
  if (!this.creadoEn) {
    this.creadoEn = new Date();
  }
  const d = new Date(this.creadoEn);
  const año = d.getFullYear();
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  this.fechaDia = `${año}-${mes}-${dia}`;
  next();
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

    // Validar que se envíen coordenadas
    if (lat == null || lng == null) {
      return res.status(400).json({ 
        mensaje: 'Se requiere ubicación GPS para registrar' 
      });
    }

    // Obtener coordenadas de la zona desde variables de entorno
    const ZONA_LAT = 3.17253;
    const ZONA_LNG = -76.4588;
    const ZONA_RADIO_METROS = parseFloat(process.env.ZONA_RADIO_METROS || '35');

    // Calcular distancia
    const distancia = distanciaMetros(lat, lng, ZONA_LAT, ZONA_LNG);
    const dentroZona = distancia <= ZONA_RADIO_METROS;

    // ⚠️ VALIDACIÓN ACTIVADA: Bloquear registros fuera de la planta
    if (!dentroZona) {
      return res.status(403).json({
        mensaje: `No estás dentro de la zona de trabajo autorizada. Distancia: ${distancia.toFixed(0)} metros (máximo: ${ZONA_RADIO_METROS}m)`,
        dentroZona: false,
        distancia: distancia.toFixed(0),
      });
    }

    // Guardamos el registro con la hora del servidor
    const nuevoRegistro = new Registro({
      nombreOperario,
      tipo,
      lat,
      lng,
      dentroZona,
      distancia: distancia.toFixed(0),
    });

    await nuevoRegistro.save();

    res.json({
      mensaje: `Registro de ${tipo} guardado correctamente para ${nombreOperario}`,
      dentroZona,
      distancia: distancia.toFixed(0),
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
// 6. Eliminar registros por operario y rango de fechas
app.delete('/api/registros-rango', async (req, res) => {
  try {
    const { operario, desde, hasta } = req.body;

    // Validar que llegaron los datos básicos
    if (!operario || !desde || !hasta) {
      return res
        .status(400)
        .json({ mensaje: 'Debes enviar operario, desde y hasta (YYYY-MM-DD)' });
    }

    // Construir los límites de fecha
    // Ej: desde = "2025-11-01", hasta = "2025-11-07"
    const inicio = new Date(`${desde}T00:00:00`);
    const fin = new Date(`${hasta}T23:59:59`);

    // Filtro: nombre + rango de fechas usando el campo creadoEn
    const filtro = {
      nombreOperario: operario,
      creadoEn: { $gte: inicio, $lte: fin },
    };

    // deleteMany devuelve cuántos documentos borró
    const resultado = await Registro.deleteMany(filtro);

    res.json({
      mensaje: 'Registros eliminados correctamente',
      operario,
      desde,
      hasta,
      eliminados: resultado.deletedCount,
    });
  } catch (error) {
    console.error('Error al eliminar registros por rango:', error);
    res.status(500).json({ mensaje: 'Error al eliminar registros' });
  }
});

// 6. Ruta de reporte de horas por operario y rango de fechas
app.get('/api/reporte-horas', async (req, res) => {
  try {
    const { operario, desde, hasta } = req.query;

    if (!operario || !desde || !hasta) {
      return res
        .status(400)
        .json({ mensaje: 'Debes enviar operario, desde y hasta (YYYY-MM-DD)' });
    }

    // Construimos las fechas de inicio y fin
    const inicio = new Date(`${desde}T00:00:00`);
    const fin = new Date(`${hasta}T23:59:59`);

    // 1. Traer registros del operario en ese rango
    const registros = await Registro.find({
      nombreOperario: operario,
      creadoEn: { $gte: inicio, $lte: fin },
    }).sort({ creadoEn: 1 });

    if (registros.length === 0) {
      return res.json({
        operario,
        desde,
        hasta,
        totalHoras: 0,
        horasNormales: 0,
        horasExtra: 0,
        horasDominicales: 0,
        detalle: [],
      });
    }

    // 2. Armar pares ingreso–salida
    const intervalos = [];
    let ultimoIngreso = null;

    for (const reg of registros) {
      if (reg.tipo === 'ingreso') {
        ultimoIngreso = reg.creadoEn;
      } else if (reg.tipo === 'salida' && ultimoIngreso) {
        // Creamos intervalo [ingreso, salida]
        intervalos.push({
          inicio: new Date(ultimoIngreso),
          fin: new Date(reg.creadoEn),
        });
        ultimoIngreso = null;
      }
    }

    // 3. Funciones auxiliares para calcular horas en bloques
    function horasEntre(fechaInicio, fechaFin) {
      const ms = fechaFin - fechaInicio;
      return ms > 0 ? ms / (1000 * 60 * 60) : 0;
    }

    function mismoDia(d) {
      const año = d.getFullYear();
      const mes = String(d.getMonth() + 1).padStart(2, '0');
      const dia = String(d.getDate()).padStart(2, '0');
      return `${año}-${mes}-${dia}`;
    }

    function esDomingo(d) {
      // 0 = domingo, 1 = lunes, ... 6 = sábado
      return d.getDay() === 0;
    }

    // Dado un intervalo, lo partimos por día y calculamos horas
    let horasNormales = 0;
    let horasExtra = 0;
    let horasDominicales = 0;
    const detalle = [];

    for (const intervalo of intervalos) {
      let actual = new Date(intervalo.inicio);

      while (actual < intervalo.fin) {
        // Tomamos el día de este "trozo"
        const inicioDia = new Date(
          actual.getFullYear(),
          actual.getMonth(),
          actual.getDate(),
          0,
          0,
          0
        );
        const finDia = new Date(
          actual.getFullYear(),
          actual.getMonth(),
          actual.getDate(),
          23,
          59,
          59
        );

        const inicioSegmento = new Date(Math.max(actual, inicioDia));
        const finSegmento = new Date(Math.min(intervalo.fin, finDia));

        const fechaTexto = mismoDia(inicioSegmento);
        const domingo = esDomingo(inicioSegmento);

        // Definir bloques de ese día
        const bloqueManianaInicio = new Date(
          inicioSegmento.getFullYear(),
          inicioSegmento.getMonth(),
          inicioSegmento.getDate(),
          7,
          0,
          0
        );
        const bloqueManianaFin = new Date(
          inicioSegmento.getFullYear(),
          inicioSegmento.getMonth(),
          inicioSegmento.getDate(),
          12,
          0,
          0
        );

        const bloqueTardeInicio = new Date(
          inicioSegmento.getFullYear(),
          inicioSegmento.getMonth(),
          inicioSegmento.getDate(),
          14,
          0,
          0
        );
        const bloqueTardeFin = new Date(
          inicioSegmento.getFullYear(),
          inicioSegmento.getMonth(),
          inicioSegmento.getDate(),
          17,
          0,
          0
        );

        const bloqueExtraInicio = new Date(
          inicioSegmento.getFullYear(),
          inicioSegmento.getMonth(),
          inicioSegmento.getDate(),
          17,
          0,
          0
        );
        const bloqueExtraFin = finDia; // todo lo que pase de las 17:00

        // Intersecciones con cada bloque
        function interseccion(inicioBloque, finBloque) {
          const ini = new Date(Math.max(inicioSegmento, inicioBloque));
          const fin = new Date(Math.min(finSegmento, finBloque));
          if (fin <= ini) return 0;
          return horasEntre(ini, fin);
        }

        const horasManiana = interseccion(
          bloqueManianaInicio,
          bloqueManianaFin
        );
        const horasTarde = interseccion(bloqueTardeInicio, bloqueTardeFin);
        const horasExtraDia = interseccion(bloqueExtraInicio, bloqueExtraFin);

        let horasNormalesDia = horasManiana + horasTarde;

        if (domingo) {
          // Todo lo normal de ese día se considera dominical
          horasDominicales += horasNormalesDia + horasExtraDia;
          detalle.push({
            fecha: fechaTexto,
            domingo: true,
            horasNormalesDia,
            horasExtraDia,
            horasDominicalesDia: horasNormalesDia + horasExtraDia,
          });
        } else {
          horasNormales += horasNormalesDia;
          horasExtra += horasExtraDia;
          detalle.push({
            fecha: fechaTexto,
            domingo: false,
            horasNormalesDia,
            horasExtraDia,
            horasDominicalesDia: 0,
          });
        }

        // Avanzamos al siguiente día
        actual = new Date(
          inicioSegmento.getFullYear(),
          inicioSegmento.getMonth(),
          inicioSegmento.getDate() + 1,
          0,
          0,
          0
        );
      }
    }

    const totalHoras = horasNormales + horasExtra + horasDominicales;

    res.json({
      operario,
      desde,
      hasta,
      totalHoras: Number(totalHoras.toFixed(2)),
      horasNormales: Number(horasNormales.toFixed(2)),
      horasExtra: Number(horasExtra.toFixed(2)),
      horasDominicales: Number(horasDominicales.toFixed(2)),
      detalle,
    });
  } catch (error) {
    console.error('Error en /api/reporte-horas:', error);
    res.status(500).json({ mensaje: 'Error al generar el reporte' });
  }
});

// 6. Iniciar el servidor
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
});







