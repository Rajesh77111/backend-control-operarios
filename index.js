// index.js
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware
app.use(express.json());
app.use(cors());

// 1. Conexión a MongoDB Atlas
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Conectado a MongoDB Atlas'))
  .catch((err) => console.error('❌ Error al conectar a MongoDB:', err));

// 2. Schema de Registro (con justificación de horas extra)
const registroSchema = new mongoose.Schema({
  nombreOperario: { type: String, required: true },
  tipo: { type: String, enum: ['ingreso', 'salida'], required: true },
  lat: Number,
  lng: Number,
  dentroZona: Boolean,
  creadoEn: { type: Date, default: Date.now },
  fechaDia: { type: String }, // "2025-11-24"
  distancia: { type: String },
  justificacionExtra: { type: String }, // Nueva: justificación de horas extra
});

const Registro = mongoose.model('Registro', registroSchema);

// 3. Schema de Permisos (NUEVO)
const permisoSchema = new mongoose.Schema({
  nombreOperario: { type: String, required: true },
  fechaPermiso: { type: String, required: true }, // "2025-11-24"
  horasPermiso: { type: Number, required: true },
  motivo: { type: String, required: true },
  creadoEn: { type: Date, default: Date.now },
});

const Permiso = mongoose.model('Permiso', permisoSchema);

// 4. Función de distancia
function distanciaMetros(lat1, lng1, lat2, lng2) {
  const R = 6371000;
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

// 5. Ruta para registrar ingreso o salida (MEJORADA)
app.post('/api/registro', async (req, res) => {
  try {
    const { nombreOperario, tipo, lat, lng, justificacionExtra } = req.body;

    if (!nombreOperario || !tipo) {
      return res.status(400).json({ mensaje: 'Faltan datos obligatorios' });
    }

    if (lat == null || lng == null) {
      return res.status(400).json({
        mensaje: 'Se requiere ubicación GPS para registrar',
      });
    }

    // Fecha del día
    const ahora = new Date();
    const año = ahora.getFullYear();
    const mes = String(ahora.getMonth() + 1).padStart(2, '0');
    const dia = String(ahora.getDate()).padStart(2, '0');
    const fechaDia = `${año}-${mes}-${dia}`;

    // ⚠️ VALIDACIÓN: Solo un registro de cada tipo por día
    const yaExiste = await Registro.findOne({
      nombreOperario,
      tipo,
      fechaDia,
    });

    if (yaExiste) {
      return res.status(400).json({
        mensaje: `Ya registraste un ${tipo} hoy (${fechaDia}). Solo puedes registrar ${tipo} una vez por día.`,
      });
    }

    // Validar zona
    const ZONA_LAT = parseFloat(process.env.ZONA_LAT);
    const ZONA_LNG = parseFloat(process.env.ZONA_LNG);
    const ZONA_RADIO_METROS = parseFloat(process.env.ZONA_RADIO_METROS || '35');

    const distancia = distanciaMetros(lat, lng, ZONA_LAT, ZONA_LNG);
    const dentroZona = distancia <= ZONA_RADIO_METROS;

    if (!dentroZona) {
      return res.status(403).json({
        mensaje: `No estás dentro de la zona de trabajo autorizada. Distancia: ${distancia.toFixed(
          0
        )} metros (máximo: ${ZONA_RADIO_METROS}m)`,
        dentroZona: false,
        distancia: distancia.toFixed(0),
      });
    }

    // ⚠️ VALIDACIÓN: Si es salida después de las 17:00, exigir justificación
    if (tipo === 'salida') {
      const horaLocal = ahora.getHours();
      if (horaLocal >= 17) {
        if (!justificacionExtra || !justificacionExtra.trim()) {
          return res.status(400).json({
            mensaje:
              'Esta salida registra horas extra (después de las 17:00). Debes escribir una justificación.',
          });
        }
      }
    }

    // Guardar registro
    const nuevoRegistro = new Registro({
      nombreOperario,
      tipo,
      lat,
      lng,
      dentroZona,
      distancia: distancia.toFixed(0),
      fechaDia,
      justificacionExtra: justificacionExtra || undefined,
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

// 6. Ver registros
app.get('/api/registros', async (req, res) => {
  const registros = await Registro.find().sort({ creadoEn: -1 }).limit(100);
  res.json(registros);
});

// 7. Eliminar registros por rango
app.delete('/api/registros-rango', async (req, res) => {
  try {
    const { operario, desde, hasta } = req.body;

    if (!operario || !desde || !hasta) {
      return res
        .status(400)
        .json({ mensaje: 'Debes enviar operario, desde y hasta (YYYY-MM-DD)' });
    }

    const inicio = new Date(`${desde}T00:00:00`);
    const fin = new Date(`${hasta}T23:59:59`);

    const filtro = {
      nombreOperario: operario,
      creadoEn: { $gte: inicio, $lte: fin },
    };

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

// 8. Reporte de horas con descuento de permisos (MEJORADO)
app.get('/api/reporte-horas', async (req, res) => {
  try {
    const { operario, desde, hasta } = req.query;

    if (!operario || !desde || !hasta) {
      return res
        .status(400)
        .json({ mensaje: 'Debes enviar operario, desde y hasta (YYYY-MM-DD)' });
    }

    const inicio = new Date(`${desde}T00:00:00`);
    const fin = new Date(`${hasta}T23:59:59`);

    // 1. Traer registros
    const registros = await Registro.find({
      nombreOperario: operario,
      creadoEn: { $gte: inicio, $lte: fin },
    }).sort({ creadoEn: 1 });

    // 2. Traer permisos en el mismo rango
    const permisos = await Permiso.find({
      nombreOperario: operario,
      fechaPermiso: { $gte: desde, $lte: hasta },
    });

    const totalHorasPermiso = permisos.reduce((sum, p) => sum + p.horasPermiso, 0);

    if (registros.length === 0) {
      return res.json({
        operario,
        desde,
        hasta,
        totalHoras: 0,
        horasNormales: 0,
        horasExtra: 0,
        horasDominicales: 0,
        horasPermiso: totalHorasPermiso,
        detalle: [],
      });
    }

    // 3. Armar intervalos ingreso-salida
    const intervalos = [];
    let ultimoIngreso = null;

    for (const reg of registros) {
      if (reg.tipo === 'ingreso') {
        ultimoIngreso = reg.creadoEn;
      } else if (reg.tipo === 'salida' && ultimoIngreso) {
        intervalos.push({
          inicio: new Date(ultimoIngreso),
          fin: new Date(reg.creadoEn),
        });
        ultimoIngreso = null;
      }
    }

    // 4. Calcular horas por bloques
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
      return d.getDay() === 0;
    }

    let horasNormales = 0;
    let horasExtra = 0;
    let horasDominicales = 0;
    const detalle = [];

    for (const intervalo of intervalos) {
      let actual = new Date(intervalo.inicio);

      while (actual < intervalo.fin) {
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

        // Bloques
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
        const bloqueExtraFin = finDia;

        function interseccion(inicioBloque, finBloque) {
          const ini = new Date(Math.max(inicioSegmento, inicioBloque));
          const fin = new Date(Math.min(finSegmento, finBloque));
          if (fin <= ini) return 0;
          return horasEntre(ini, fin);
        }

        const horasManiana = interseccion(bloqueManianaInicio, bloqueManianaFin);
        const horasTarde = interseccion(bloqueTardeInicio, bloqueTardeFin);
        const horasExtraDia = interseccion(bloqueExtraInicio, bloqueExtraFin);

        let horasNormalesDia = horasManiana + horasTarde;

        if (domingo) {
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
      horasPermiso: Number(totalHorasPermiso.toFixed(2)),
      detalle,
    });
  } catch (error) {
    console.error('Error en /api/reporte-horas:', error);
    res.status(500).json({ mensaje: 'Error al generar el reporte' });
  }
});

// ========== NUEVAS RUTAS PARA PERMISOS ==========

// 9. Crear permiso
app.post('/api/permisos', async (req, res) => {
  try {
    const { nombreOperario, fechaPermiso, horasPermiso, motivo } = req.body;

    if (!nombreOperario || !fechaPermiso || !horasPermiso || !motivo) {
      return res.status(400).json({
        mensaje: 'Debes enviar nombreOperario, fechaPermiso, horasPermiso y motivo',
      });
    }

    const nuevoPermiso = new Permiso({
      nombreOperario,
      fechaPermiso,
      horasPermiso: parseFloat(horasPermiso),
      motivo,
    });

    await nuevoPermiso.save();

    res.json({
      mensaje: 'Permiso registrado correctamente',
      permiso: nuevoPermiso,
    });
  } catch (error) {
    console.error('Error al crear permiso:', error);
    res.status(500).json({ mensaje: 'Error al registrar permiso' });
  }
});

// 10. Listar permisos por operario y rango
app.get('/api/permisos', async (req, res) => {
  try {
    const { operario, desde, hasta } = req.query;

    if (!operario || !desde || !hasta) {
      return res.status(400).json({
        mensaje: 'Debes enviar operario, desde y hasta',
      });
    }

    const permisos = await Permiso.find({
      nombreOperario: operario,
      fechaPermiso: { $gte: desde, $lte: hasta },
    }).sort({ fechaPermiso: 1 });

    res.json(permisos);
  } catch (error) {
    console.error('Error al listar permisos:', error);
    res.status(500).json({ mensaje: 'Error al listar permisos' });
  }
});

// 11. Eliminar permiso
app.delete('/api/permisos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const resultado = await Permiso.findByIdAndDelete(id);

    if (!resultado) {
      return res.status(404).json({ mensaje: 'Permiso no encontrado' });
    }

    res.json({ mensaje: 'Permiso eliminado correctamente' });
  } catch (error) {
    console.error('Error al eliminar permiso:', error);
    res.status(500).json({ mensaje: 'Error al eliminar permiso' });
  }
});

// 12. Iniciar servidor
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
});
