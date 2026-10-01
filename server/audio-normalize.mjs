/**
 * NORMALIZACIÓN DE AUDIO — dejar el archivo en un formato que WhatsApp acepta.
 *
 * POR QUÉ EXISTE
 * WhatsApp Cloud API acepta, para audio, SOLO estos tipos:
 *   audio/aac · audio/mp4 · audio/mpeg · audio/amr · audio/ogg · audio/opus
 * y, dentro de `audio/ogg`, **solo el códec OPUS** (Vorbis no vale, aunque el
 * archivo sea un .ogg perfectamente válido).
 *
 * El navegador, en cambio, graba lo que puede: Chrome/Edge en Windows producen
 * **audio/webm;codecs=opus**. Eso no es ninguna de las opciones de arriba, así que
 * Meta lo rechaza con un 400 («Param file must be a file with one of the following
 * types: …»). Reproducido de verdad contra la API: ver `probe-upload.mjs`.
 *
 * QUÉ HACE ESTE MÓDULO
 *   1. MIRAR el archivo (por bytes, no por extensión): ¿es un contenedor que Meta
 *      acepta y, si es Ogg, lleva Opus dentro?
 *   2. Si se identifica como NO aceptado (WebM/WAV, o un Ogg con Vorbis/FLAC/Theora
 *      dentro), CONVERTIRLO a Ogg/Opus con ffmpeg: mono, 48 kHz, 24 kbps y perfil
 *      de voz. Una nota de 60 s ocupa ~180 KB (el límite son 16 MB).
 *   3. Si no se puede convertir, decirlo con un código claro — nunca dejar que el
 *      usuario vea un «no parece un audio» que no explica nada.
 *
 * NO convierte lo que ya es válido, ni lo que no sabe leer (convertir a ciegas un
 * archivo raro es peor que enviarlo): es la regla de «no convertir de más».
 *
 * ffmpeg es OPCIONAL: si no está en la máquina, el módulo lo dice
 * (`converter_missing`) y el CRM responde con un mensaje útil. Se prefiere que
 * funcione sin él a que se caiga por su ausencia.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Los tipos de audio que WhatsApp acepta TAL CUAL (los de su propio error 400). */
export const META_AUDIO_MIME = Object.freeze([
  'audio/aac',
  'audio/mp4',
  'audio/mpeg',
  'audio/amr',
  'audio/ogg',
  'audio/opus',
]);

/** Contenedores que sabemos convertir (aunque Meta no los acepte directamente). */
export const CONVERTIBLE_AUDIO_MIME = Object.freeze([
  'audio/webm',
  'audio/mp4',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/opus',
  'video/webm',
]);

const DELIVERY_UNSTABLE_AUDIO_MIME = Object.freeze([
  'audio/mp4',
  'audio/aac',
]);

/** Salida de la conversión: el formato más seguro para voz. */
export const NORMALIZED_MIME = 'audio/ogg';

/** Ajustes de la conversión (voz: se entiende, no suena a lata, no pesa). */
const FFMPEG_AUDIO_ARGS = Object.freeze([
  '-vn',
  '-ac', '1',            // mono: es una nota de voz
  '-ar', '48000',        // 48 kHz, lo natural en Opus
  '-c:a', 'libopus',
  '-b:a', '24k',
  '-application', 'voip',
  '-f', 'ogg',
]);

const TIMEOUT_MS = 20000;

/** ¿Hay ffmpeg? Se pregunta UNA vez por proceso. */
let cacheFfmpeg = null;
export function ffmpegInfo() {
  if (cacheFfmpeg) return cacheFfmpeg;
  try {
    const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 5000 });
    cacheFfmpeg =
      probe.status === 0
        ? { available: true, version: String(probe.stdout ?? '').split('\n')[0].slice(0, 80) }
        : { available: false, version: null };
  } catch {
    cacheFfmpeg = { available: false, version: null };
  }
  return cacheFfmpeg;
}

/** Solo para pruebas: olvida la detección anterior. */
export function resetFfmpegCache() {
  cacheFfmpeg = null;
}

/**
 * Qué códec lleva DENTRO un contenedor Ogg.
 *
 * Un `.ogg` puede llevar Opus (lo que Meta acepta) o Vorbis (lo que Meta NO
 * acepta, aunque el archivo sea válido). La diferencia está en la primera página
 * del contenedor: `OpusHead` o `\x01vorbis`. Se mira a mano porque leer 4 KB es
 * infinitamente más barato que arrancar un decodificador.
 *
 * @param {Buffer} buffer
 * @returns {'opus'|'vorbis'|'flac'|'theora'|'unknown'}
 */
export function oggCodec(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return 'unknown';
  const head = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (head.includes('OpusHead')) return 'opus';
  if (head.includes('\x01vorbis')) return 'vorbis';
  if (head.includes('fLaC')) return 'flac';
  if (head.includes('\x80theora')) return 'theora';
  return 'unknown';
}

/**
 * ¿Hay que convertir este audio antes de subirlo a Meta?
 *
 * @param {{ buffer: Buffer, mimeType: string|null }} input
 * @returns {{ convert: boolean, reason: string, codec: string|null, mimeType: string }}
 *   `reason`: 'meta_safe' | 'codec_unsupported' | 'codec_unknown' | 'container_unsupported' | 'unknown_container'
 */
export function audioDecision({ buffer, mimeType }) {
  const mime = String(mimeType ?? '').split(';')[0].trim().toLowerCase();
  if (mime === 'audio/ogg' || mime === 'audio/opus') {
    const codec = oggCodec(buffer);
    if (codec === 'opus') return { convert: false, reason: 'meta_safe', codec, mimeType: 'audio/ogg' };
    /*
     * Vorbis / FLAC / Theora: Meta NO los acepta dentro de un Ogg, y sabemos
     * exactamente qué son → se convierten.
     *
     * Un Ogg cuyo códec no se reconoce se DEJA PASAR a propósito: puede ser un
     * archivo raro pero válido, y convertir a ciegas lo que no se entiende es
     * peor que enviarlo (Meta sí acepta la subida). La diferencia se registra.
     */
    const sospechoso = codec === 'vorbis' || codec === 'flac' || codec === 'theora';
    return {
      convert: sospechoso,
      reason: sospechoso ? 'codec_unsupported' : 'codec_unknown',
      codec,
      mimeType: 'audio/ogg',
    };
  }
  if (DELIVERY_UNSTABLE_AUDIO_MIME.includes(mime)) {
    return { convert: true, reason: 'delivery_unstable_container', codec: null, mimeType: mime };
  }
  if (META_AUDIO_MIME.includes(mime)) {
    return { convert: false, reason: 'meta_safe', codec: null, mimeType: mime };
  }
  if (CONVERTIBLE_AUDIO_MIME.includes(mime)) {
    return { convert: true, reason: 'container_unsupported', codec: null, mimeType: mime || 'audio/desconocido' };
  }
  return { convert: true, reason: 'unknown_container', codec: null, mimeType: mime || 'audio/desconocido' };
}

/** Ejecuta ffmpeg con entrada y salida en ARCHIVOS (el pipe no vale para todo). */
function runFfmpeg(inputPath, outputPath, extraArgs = []) {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', inputPath, ...extraArgs, outputPath];
  const run = spawnSync('ffmpeg', args, { encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 });
  return {
    ok: run.status === 0,
    status: run.status,
    signal: run.signal ?? null,
    timedOut: run.signal === 'SIGTERM' || run.error?.code === 'ETIMEDOUT',
    error: String(run.stderr ?? '').trim().slice(0, 200),
  };
}

/** Metadatos técnicos del archivo (para el log). Nunca lanza. */
function describeWithFfprobe(filePath) {
  try {
    const probe = spawnSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,sample_rate,channels', '-of', 'default=noprint_wrappers=1', filePath],
      { encoding: 'utf8', timeout: 8000 },
    );
    if (probe.status !== 0) return null;
    const salida = String(probe.stdout ?? '');
    const valor = (clave) => (salida.match(new RegExp(`^${clave}=(.*)$`, 'm')) ?? [])[1] ?? null;
    const segundos = Number(valor('duration'));
    return {
      codec: valor('codec_name'),
      sampleRate: Number(valor('sample_rate')) || null,
      channels: Number(valor('channels')) || null,
      durationMs: Number.isFinite(segundos) && segundos > 0 ? Math.round(segundos * 1000) : null,
    };
  } catch {
    return null;
  }
}

/**
 * Deja el audio en Ogg/Opus (o lo deja como está si ya era válido).
 *
 * Garantías:
 *   · Los archivos temporales viven en su PROPIA carpeta y se borran siempre
 *     (`finally`), incluso si ffmpeg falla.
 *   · Un timeout no cuelga el proceso (ffmpeg se mata y se devuelve error).
 *   · Nunca devuelve un buffer vacío como si fuera éxito.
 *
 * @param {{ buffer: Buffer, mimeType: string|null, filename?: string|null, tmpDir?: string|null }} input
 *   `tmpDir` es opcional: por defecto el temporal del sistema. Se puede fijar
 *   (contenedores con /tmp pequeño o de solo lectura, y pruebas aisladas).
 * @returns {Promise<{ ok: true, converted: boolean, buffer: Buffer, mimeType: string, codec: string|null,
 *                     reason: string, probe: any|null } |
 *                   { ok: false, error: { code: string, message: string } }>}
 */
export async function normalizeAudio({ buffer, mimeType, filename = null, tmpDir = null }) {
  const decision = audioDecision({ buffer, mimeType });
  const base = {
    converted: false,
    inMime: decision.mimeType,
    reason: decision.reason,
    codec: decision.codec,
    sizeIn: buffer?.length ?? 0,
  };

  if (!decision.convert) return { ok: true, ...base, buffer, mimeType: decision.mimeType, probe: null };
  const ffmpeg = ffmpegInfo();
  if (!ffmpeg.available) {
    return {
      ok: false,
      ...base,
      error: {
        code: 'converter_missing',
        message:
          decision.reason === 'codec_unsupported'
            ? 'Ese audio OGG lleva Vorbis, y WhatsApp solo acepta Opus. Convierte el archivo a OGG/Opus o a M4A.'
            : 'Ese audio viene en un formato que WhatsApp no acepta y aquí no hay conversor disponible. Adjúntalo en OGG/Opus, M4A o MP3.',
      },
    };
  }

  const dir = mkdtempSync(path.join(tmpDir ?? os.tmpdir(), 'phyto-audio-'));
  const extensionEntrada = (String(filename ?? '').match(/\.([A-Za-z0-9]{2,5})$/) ?? [, 'bin'])[1].toLowerCase();
  const entrada = path.join(dir, `entrada.${extensionEntrada}`);
  const salida = path.join(dir, 'salida.ogg');
  try {
    writeFileSync(entrada, buffer);
    const corrida = runFfmpeg(entrada, salida, FFMPEG_AUDIO_ARGS);
    if (!corrida.ok) {
      return {
        ok: false,
        ...base,
        error: {
          code: corrida.timedOut ? 'convert_timeout' : 'convert_failed',
          message: corrida.timedOut
            ? 'La conversión del audio tardó demasiado. Prueba con una nota más corta.'
            : 'No se pudo convertir el audio. Prueba con otra grabación.',
        },
      };
    }
    const convertido = readFileSync(salida);
    if (!convertido.length) {
      return { ok: false, ...base, error: { code: 'convert_empty', message: 'La conversión salió vacía: el audio no tiene sonido aprovechable.' } };
    }
    return {
      ok: true,
      ...base,
      converted: true,
      buffer: convertido,
      mimeType: NORMALIZED_MIME,
      probe: describeWithFfprobe(salida),
    };
  } catch (error) {
    return { ok: false, ...base, error: { code: 'convert_failed', message: `No se pudo convertir el audio (${String(error?.code ?? error?.name ?? 'error')}).` } };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* una limpieza que falla no puede cambiar el resultado */
    }
  }
}
