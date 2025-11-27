// index.js - Backend con soporte para PTAP y PTAR
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();

app.use(express.json());
app.use(cors());

// Conexión a MongoDB
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Conectado a MongoDB Atlas'))
  .catch((err) => console.error('❌ Error al conectar a MongoDB:', err));

// ==================== SCHEMAS ====================

// Schema de Registro (ahora incluye planta)
const registroSchema = new mongoose.Schema({
  nombreOperario: { type: String, required: true },
  planta: { type: String, enum: ['PTAP', 'PTAR'], required: true },
  tipo: { type: String, enum: ['ingreso', 'salida'], required: true },
  lat: Number,
  lng: Number,
  dentroZona: Boolean,
  creadoEn: { type: Date, default: Date.now },
  fechaDia: { type: String }, // "2025-11-26"
  distancia: { type: String },
  justificacionExtra: { type: String },
  turno: { type: String }, // Para PTAR: "mañana", "tarde", "noche"
});

const Registro = mongoose.model('Registro', registroSchema);

// Schema de Permisos
const permisoSchema = new mongoose.Schema({
  nombreOperario: { type: String, required: true },
  planta: { type: String, enum: ['PTAP', 'PTAR'], required: true },
  fechaPermiso: { type: String, required: true },
  horasPermiso: { type: Number, required: true },
  motivo: { type: String, required: true },
  creadoEn: { type: Date, default: Date.now },
});

const Permiso = mongoose.model('Permiso', permisoSchema);

// ==================== CONFIGURACIÓN DE PLANTAS ====================

const PLANTAS_CONFIG = {
  PTAP: {
    lat: parseFloat(process.env.PTAP_LAT || '3.17253'),
    lng: parseFloat(process.env.PTAP_LNG || '-76.4588'),
    radio: parseFloat(process.env.PTAP_RADIO || '35'),
  },
  PTAR: {
    lat: parseFloat(process.env.PTAR_LAT || '3.17300'),
    lng: parseFloat(process.env.PTAR_LNG || '-76.4600'),
    radio: parseFloat(process.env.PTAR_RADIO || '50'),
  }
};

// ==================== FUNCIONES AUXILIARES ====================

function distanciaMetros(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (grado) => (grado * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function obtenerFechaDia(fecha) {
  const año = fecha.getFullYear();
  const mes = String(fecha.getMonth() + 1).padStart(2, '0');
  const dia = String(fecha.getDate()).padStart(2, '0');
  return `${año}-${mes}-${dia}`;
}

function determinarTurno(hora) {
  // Turnos PTAR: 6-14 (mañana), 14-22 (tarde), 22-6 (noche)
  if (hora >= 6 && hora < 14) return 'mañana';
  if (hora >= 14 && hora < 22) return 'tarde';
  return 'noche';
}

// Obtener inicio y fin de semana (lunes a domingo)
function obtenerSemana(fecha) {
  const dia = new Date(fecha);
  const diaSemana = dia.getDay(); // 0=domingo, 1=lunes, etc.
  const diff = diaSemana === 0 ? -6 : 1 - diaSemana; // Ajustar para que lunes sea inicio
  
  const inicioSemana = new Date(dia);
  inicioSemana.setDate(dia.getDate() + diff);
  inicioSemana.setHours(0, 0, 0, 0);
  
  const finSemana = new Date(inicioSemana);
  finSemana.setDate(inicioSemana.getDate() + 6);
  finSemana.setHours(23, 59, 59, 999);
  
  return { inicio: inicioSemana, fin: finSemana };
}

// ==================== RUTAS ====================

// Obtener configuración de planta
app.get('/api/config-planta/:planta', (req, res) => {
  const { planta } = req.params;
  const config = PLANTAS_CONFIG[planta];
  
  if (!config) {
    return res.status(404).json({ mensaje: 'Planta no encontrada' });
  }
  
  res.json(config);
});

// Registrar ingreso/salida
app.post('/api/registro', async (req, res) => {
  try {
    const { nombreOperario, planta, tipo, lat, lng, justificacionExtra } = req.body;

    if (!nombreOperario || !planta || !tipo) {
      return res.status(400).json({ mensaje: 'Faltan datos obligatorios' });
    }

    if (!['PTAP', 'PTAR'].includes(planta)) {
      return res.status(400).json({ mensaje: 'Planta inválida' });
    }

    if (lat == null || lng == null) {
      return res.status(400).json({ mensaje: 'Se requiere ubicación GPS' });
    }

    const ahora = new Date();
        // Hora local de Colombia (America/Bogota, UTC-5)
    const horaLocalColombia = (ahora.getUTCHours() + 24 - 5) % 24;

    const fechaDia = obtenerFechaDia(ahora);

    // Validar un solo registro por tipo por día
    const yaExiste = await Registro.findOne({
      nombreOperario,
      planta,
      tipo,
      fechaDia,
    });

    if (yaExiste) {
      return res.status(400).json({
        mensaje: `Ya registraste un ${tipo} hoy para ${planta}`,
      });
    }

    // Validar geocerca
    const config = PLANTAS_CONFIG[planta];
    const distancia = distanciaMetros(lat, lng, config.lat, config.lng);
    const dentroZona = distancia <= config.radio;

    if (!dentroZona) {
      return res.status(403).json({
        mensaje: `No estás en la zona de ${planta}. Distancia: ${distancia.toFixed(0)}m (máximo: ${config.radio}m)`,
        dentroZona: false,
        distancia: distancia.toFixed(0),
      });
    }

       // Validar justificación para PTAP (después de las 17:00 hora Colombia)
    if (planta === 'PTAP' && tipo === 'salida') {
      if (horaLocalColombia >= 17 && (!justificacionExtra || !justificacionExtra.trim())) {
        return res.status(400).json({
          mensaje: 'Salida después de las 17:00 (hora Colombia) requiere justificación',
        });
      }
    }


    // Determinar turno para PTAR
    const turno = planta === 'PTAR' ? determinarTurno(ahora.getHours()) : null;

    const nuevoRegistro = new Registro({
      nombreOperario,
      planta,
      tipo,
      lat,
      lng,
      dentroZona,
      distancia: distancia.toFixed(0),
      fechaDia,
      justificacionExtra: justificacionExtra || undefined,
      turno,
    });

    await nuevoRegistro.save();

    res.json({
      mensaje: `Registro de ${tipo} guardado para ${planta}`,
      dentroZona,
      distancia: distancia.toFixed(0),
      turno,
      registro: nuevoRegistro,
    });
  } catch (error) {
    console.error('Error al guardar registro:', error);
    res.status(500).json({ mensaje: 'Error en el servidor' });
  }
});

// Ver registros
app.get('/api/registros', async (req, res) => {
  const { planta } = req.query;
  const filtro = planta ? { planta } : {};
  const registros = await Registro.find(filtro).sort({ creadoEn: -1 }).limit(100);
  res.json(registros);
});

// Eliminar registros por rango
app.delete('/api/registros-rango', async (req, res) => {
  try {
    const { operario, planta, desde, hasta } = req.body;

    if (!operario || !planta || !desde || !hasta) {
      return res.status(400).json({ mensaje: 'Datos incompletos' });
    }

    const inicio = new Date(`${desde}T00:00:00`);
    const fin = new Date(`${hasta}T23:59:59`);

    const resultado = await Registro.deleteMany({
      nombreOperario: operario,
      planta,
      creadoEn: { $gte: inicio, $lte: fin },
    });

    res.json({
      mensaje: 'Registros eliminados',
      eliminados: resultado.deletedCount,
    });
  } catch (error) {
    console.error('Error al eliminar:', error);
    res.status(500).json({ mensaje: 'Error al eliminar' });
  }
});

// ==================== REPORTE DE HORAS ====================

app.get('/api/reporte-horas', async (req, res) => {
  try {
    const { operario, planta, desde, hasta } = req.query;

    if (!operario || !planta || !desde || !hasta) {
      return res.status(400).json({ mensaje: 'Datos incompletos' });
    }

    const inicio = new Date(`${desde}T00:00:00`);
    const fin = new Date(`${hasta}T23:59:59`);

    // Traer registros y permisos
    const registros = await Registro.find({
      nombreOperario: operario,
      planta,
      creadoEn: { $gte: inicio, $lte: fin },
    }).sort({ creadoEn: 1 });

    const permisos = await Permiso.find({
      nombreOperario: operario,
      planta,
      fechaPermiso: { $gte: desde, $lte: hasta },
    });

    const totalHorasPermiso = permisos.reduce((sum, p) => sum + p.horasPermiso, 0);

    if (planta === 'PTAP') {
      return calcularHorasPTAP(operario, desde, hasta, registros, totalHorasPermiso, res);
    } else {
      return calcularHorasPTAR(operario, desde, hasta, registros, totalHorasPermiso, res);
    }
  } catch (error) {
    console.error('Error en reporte:', error);
    res.status(500).json({ mensaje: 'Error al generar reporte' });
  }
});

// Función para calcular horas PTAP (lógica existente)
function calcularHorasPTAP(operario, desde, hasta, registros, totalHorasPermiso, res) {
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

  function horasEntre(fechaInicio, fechaFin) {
    const ms = fechaFin - fechaInicio;
    return ms > 0 ? ms / (1000 * 60 * 60) : 0;
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
      const inicioDia = new Date(actual.getFullYear(), actual.getMonth(), actual.getDate(), 0, 0, 0);
      const finDia = new Date(actual.getFullYear(), actual.getMonth(), actual.getDate(), 23, 59, 59);

      const inicioSegmento = new Date(Math.max(actual, inicioDia));
      const finSegmento = new Date(Math.min(intervalo.fin, finDia));

      const fechaTexto = obtenerFechaDia(inicioSegmento);
      const domingo = esDomingo(inicioSegmento);

      const bloqueManianaInicio = new Date(inicioSegmento.getFullYear(), inicioSegmento.getMonth(), inicioSegmento.getDate(), 7, 0, 0);
      const bloqueManianaFin = new Date(inicioSegmento.getFullYear(), inicioSegmento.getMonth(), inicioSegmento.getDate(), 12, 0, 0);
      const bloqueTardeInicio = new Date(inicioSegmento.getFullYear(), inicioSegmento.getMonth(), inicioSegmento.getDate(), 14, 0, 0);
      const bloqueTardeFin = new Date(inicioSegmento.getFullYear(), inicioSegmento.getMonth(), inicioSegmento.getDate(), 17, 0, 0);
      const bloqueExtraInicio = new Date(inicioSegmento.getFullYear(), inicioSegmento.getMonth(), inicioSegmento.getDate(), 17, 0, 0);

      function interseccion(inicioBloque, finBloque) {
        const ini = new Date(Math.max(inicioSegmento, inicioBloque));
        const fin = new Date(Math.min(finSegmento, finBloque));
        if (fin <= ini) return 0;
        return horasEntre(ini, fin);
      }

      const horasManiana = interseccion(bloqueManianaInicio, bloqueManianaFin);
      const horasTarde = interseccion(bloqueTardeInicio, bloqueTardeFin);
      const horasExtraDia = interseccion(bloqueExtraInicio, finDia);

      let horasNormalesDia = horasManiana + horasTarde;

      if (domingo) {
        horasDominicales += horasNormalesDia + horasExtraDia;
        detalle.push({
          fecha: fechaTexto,
          domingo: true,
          horasNormalesDia,
          horasExtraDia,
          horasDominicalesDia: horasNormalesDia + horasExtraDia,
          horasNocturnas: 0,
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
          horasNocturnas: 0,
        });
      }

      actual = new Date(inicioSegmento.getFullYear(), inicioSegmento.getMonth(), inicioSegmento.getDate() + 1, 0, 0, 0);
    }
  }

  const totalHoras = horasNormales + horasExtra + horasDominicales;

  res.json({
    operario,
    planta: 'PTAP',
    desde,
    hasta,
    totalHoras: Number(totalHoras.toFixed(2)),
    horasNormales: Number(horasNormales.toFixed(2)),
    horasExtra: Number(horasExtra.toFixed(2)),
    horasDominicales: Number(horasDominicales.toFixed(2)),
    horasNocturnas: 0,
    horasPermiso: Number(totalHorasPermiso.toFixed(2)),
    detalle,
  });
}

// Función para calcular horas PTAR (nueva lógica)
function calcularHorasPTAR(operario, desde, hasta, registros, totalHorasPermiso, res) {
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

  // Calcular horas por semana y por día
  const semanas = {};
  const detalleDias = [];

  for (const intervalo of intervalos) {
    let actual = new Date(intervalo.inicio);

    while (actual < intervalo.fin) {
      const inicioDia = new Date(actual.getFullYear(), actual.getMonth(), actual.getDate(), 0, 0, 0);
      const finDia = new Date(actual.getFullYear(), actual.getMonth(), actual.getDate(), 23, 59, 59);

      const inicioSegmento = new Date(Math.max(actual, inicioDia));
      const finSegmento = new Date(Math.min(intervalo.fin, finDia));

           const horasDelDia = (finSegmento - inicioSegmento) / (1000 * 60 * 60);

      // === CÁLCULO DE HORAS NOCTURNAS EN HORA COLOMBIA (19:00 - 06:00) ===

      // 1) Convertimos el intervalo a hora local de Colombia
      const inicioLocal = aFechaColombia(inicioSegmento);
      const finLocal = aFechaColombia(finSegmento);

      // 2) Definimos la ventana nocturna local:
      //    desde las 19:00 del "día local" hasta las 06:00 del día siguiente.
      const inicio19hLocal = new Date(
        inicioLocal.getFullYear(),
        inicioLocal.getMonth(),
        inicioLocal.getDate(),
        19, 0, 0
      );
      const fin6hSiguienteLocal = new Date(
        inicioLocal.getFullYear(),
        inicioLocal.getMonth(),
        inicioLocal.getDate() + 1,
        6, 0, 0
      );

      let horasNocturnas = 0;

      // 3) Si el intervalo local se cruza con la franja nocturna local,
      //    calculamos la intersección.
      if (finLocal > inicio19hLocal && inicioLocal < fin6hSiguienteLocal) {
        const inicioNocturnoLocal = new Date(Math.max(inicioLocal, inicio19hLocal));
        const finNocturnoLocal = new Date(Math.min(finLocal, fin6hSiguienteLocal));

        horasNocturnas = Math.max(
          0,
          (finNocturnoLocal - inicioNocturnoLocal) / (1000 * 60 * 60)
        );
      }

      
// Convierte una fecha "real" a hora local de Colombia restando 5 horas.
// Ojo: solo la usamos para cálculos de franjas horarias.
function aFechaColombia(date) {
  const offsetMs = 5 * 60 * 60 * 1000; // 5 horas en milisegundos
  return new Date(date.getTime() - offsetMs);
}

      const fechaTexto = obtenerFechaDia(inicioSegmento);
      const semana = obtenerSemana(inicioSegmento);
      const claveSemana = `${obtenerFechaDia(semana.inicio)}_${obtenerFechaDia(semana.fin)}`;

      if (!semanas[claveSemana]) {
        semanas[claveSemana] = {
          inicio: obtenerFechaDia(semana.inicio),
          fin: obtenerFechaDia(semana.fin),
          horasTotales: 0,
          horasNormales: 0,
          horasExtra: 0,
          horasNocturnas: 0,
        };
      }

      semanas[claveSemana].horasTotales += horasDelDia;
      semanas[claveSemana].horasNocturnas += horasNocturnas;

      detalleDias.push({
        fecha: fechaTexto,
        horas: horasDelDia,
        horasNocturnas,
        semana: claveSemana,
      });

      actual = new Date(inicioSegmento.getFullYear(), inicioSegmento.getMonth(), inicioSegmento.getDate() + 1, 0, 0, 0);
    }
  }

  // Calcular normales vs extra por semana (45h límite)
  for (const claveSemana in semanas) {
    const semana = semanas[claveSemana];
    if (semana.horasTotales <= 45) {
      semana.horasNormales = semana.horasTotales;
      semana.horasExtra = 0;
    } else {
      semana.horasNormales = 45;
      semana.horasExtra = semana.horasTotales - 45;
    }
  }

  const totalHoras = Object.values(semanas).reduce((sum, s) => sum + s.horasTotales, 0);
  const totalNormales = Object.values(semanas).reduce((sum, s) => sum + s.horasNormales, 0);
  const totalExtra = Object.values(semanas).reduce((sum, s) => sum + s.horasExtra, 0);
  const totalNocturnas = Object.values(semanas).reduce((sum, s) => sum + s.horasNocturnas, 0);

  res.json({
    operario,
    planta: 'PTAR',
    desde,
    hasta,
    totalHoras: Number(totalHoras.toFixed(2)),
    horasNormales: Number(totalNormales.toFixed(2)),
    horasExtra: Number(totalExtra.toFixed(2)),
    horasDominicales: 0,
    horasNocturnas: Number(totalNocturnas.toFixed(2)),
    horasPermiso: Number(totalHorasPermiso.toFixed(2)),
    detalleSemanas: Object.values(semanas),
    detalleDias,
  });
}

// ==================== RUTAS DE PERMISOS ====================

app.post('/api/permisos', async (req, res) => {
  try {
    const { nombreOperario, planta, fechaPermiso, horasPermiso, motivo } = req.body;

    if (!nombreOperario || !planta || !fechaPermiso || !horasPermiso || !motivo) {
      return res.status(400).json({ mensaje: 'Datos incompletos' });
    }

    const nuevoPermiso = new Permiso({
      nombreOperario,
      planta,
      fechaPermiso,
      horasPermiso: parseFloat(horasPermiso),
      motivo,
    });

    await nuevoPermiso.save();

    res.json({
      mensaje: 'Permiso registrado',
      permiso: nuevoPermiso,
    });
  } catch (error) {
    console.error('Error al crear permiso:', error);
    res.status(500).json({ mensaje: 'Error al registrar permiso' });
  }
});

app.get('/api/permisos', async (req, res) => {
  try {
    const { operario, planta, desde, hasta } = req.query;

    if (!operario || !planta || !desde || !hasta) {
      return res.status(400).json({ mensaje: 'Datos incompletos' });
    }

    const permisos = await Permiso.find({
      nombreOperario: operario,
      planta,
      fechaPermiso: { $gte: desde, $lte: hasta },
    }).sort({ fechaPermiso: 1 });

    res.json(permisos);
  } catch (error) {
    console.error('Error al listar permisos:', error);
    res.status(500).json({ mensaje: 'Error al listar permisos' });
  }
});

app.delete('/api/permisos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const resultado = await Permiso.findByIdAndDelete(id);

    if (!resultado) {
      return res.status(404).json({ mensaje: 'Permiso no encontrado' });
    }

    res.json({ mensaje: 'Permiso eliminado' });
  } catch (error) {
    console.error('Error al eliminar permiso:', error);
    res.status(500).json({ mensaje: 'Error al eliminar permiso' });
  }
});

// Iniciar servidor
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
});



