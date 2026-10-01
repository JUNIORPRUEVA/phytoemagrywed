// @vitest-environment node
/**
 * AUDIO PARA WHATSAPP — qué se acepta tal cual y qué hay que convertir.
 *
 * Por qué existe este archivo: WhatsApp Cloud API acepta, para audio, solo
 * audio/aac · audio/mp4 · audio/mpeg · audio/amr · audio/ogg · audio/opus, y
 * dentro de un Ogg **solo Opus**. El navegador en Windows graba en WebM, así que
 * el audio de media plantilla se rechazaba con un 400 de Meta («Param file must
 * be a file with one of the following types: …») — reproducido de verdad contra
 * la API.
 *
 * Aquí se comprueba, sin tocar Meta ni R2:
 *   1. que se IDENTIFICA bien el archivo (contenedor y códec, por bytes),
 *   2. que NO se convierte lo que ya vale (ni lo que no se sabe leer),
 *   3. que la conversión real produce Ogg/Opus válido y no deja basura temporal,
 *   4. que sin conversor disponible se devuelve un error CLARO, nunca un éxito falso.
 *
 * Los tests de conversión real se saltan si no hay ffmpeg en la máquina.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  META_AUDIO_MIME,
  NORMALIZED_MIME,
  audioDecision,
  ffmpegInfo,
  normalizeAudio,
  oggCodec,
  resetFfmpegCache,
} from '../server/audio-normalize.mjs';

const HAY_FFMPEG = ffmpegInfo().available;
const tmp = mkdtempSync(path.join(os.tmpdir(), 'phyto-audio-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Genera un audio REAL con ffmpeg (fixtures de verdad, no bytes inventados). */
function generar(nombre, args) {
  const salida = path.join(tmp, nombre);
  const run = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=0.4', ...args, salida],
    { encoding: 'utf8' },
  );
  if (run.status !== 0) throw new Error(`ffmpeg no pudo generar ${nombre}: ${run.stderr}`);
  return readFileSync(salida);
}

/** Cabeceras sintéticas: basta para saber QUÉ lleva dentro el contenedor. */
const oggCon = (firma) => Buffer.concat([Buffer.from('OggS'), Buffer.alloc(20, 0), Buffer.from(firma), Buffer.alloc(40, 0)]);
const OGG_OPUS = oggCon('OpusHead');
const OGG_VORBIS = oggCon('\x01vorbis');
const OGG_FLAC = oggCon('fLaC');
const OGG_RARO = oggCon('MUSICA-X');
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 3)]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WAVE'), Buffer.alloc(64, 1)]);

describe('se identifica el audio por sus bytes, no por la extensión', () => {
  it('distingue Opus de Vorbis dentro de un Ogg', () => {
    expect(oggCodec(OGG_OPUS)).toBe('opus');
    expect(oggCodec(OGG_VORBIS)).toBe('vorbis');
    expect(oggCodec(OGG_FLAC)).toBe('flac');
    expect(oggCodec(OGG_RARO)).toBe('unknown');
    expect(oggCodec(Buffer.alloc(4))).toBe('unknown');
  });

  it('no convierte lo que WhatsApp ya acepta', () => {
    for (const mime of ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/amr']) {
      const decision = audioDecision({ buffer: Buffer.alloc(300, 1), mimeType: mime });
      expect(decision.convert, mime).toBe(false);
      expect(decision.reason).toBe('meta_safe');
    }
    // Ogg con Opus: es exactamente lo que Meta quiere.
    expect(audioDecision({ buffer: OGG_OPUS, mimeType: 'audio/ogg' })).toMatchObject({
      convert: false,
      codec: 'opus',
      reason: 'meta_safe',
    });
  });

  it('convierte lo que Meta NO acepta (WebM, WAV y Ogg con Vorbis/FLAC)', () => {
    expect(audioDecision({ buffer: WEBM, mimeType: 'audio/webm' })).toMatchObject({
      convert: true,
      reason: 'container_unsupported',
    });
    expect(audioDecision({ buffer: WAV, mimeType: 'audio/wav' })).toMatchObject({ convert: true });
    expect(audioDecision({ buffer: OGG_VORBIS, mimeType: 'audio/ogg' })).toMatchObject({
      convert: true,
      codec: 'vorbis',
      reason: 'codec_unsupported',
    });
    expect(audioDecision({ buffer: OGG_FLAC, mimeType: 'audio/ogg' })).toMatchObject({ convert: true });
  });

  it('un Ogg que no se sabe leer se DEJA PASAR (convertir a ciegas es peor)', () => {
    const decision = audioDecision({ buffer: OGG_RARO, mimeType: 'audio/ogg' });
    expect(decision.convert).toBe(false);
    expect(decision.reason).toBe('codec_unknown');
  });

  it('la lista de tipos aceptados por Meta es la que devuelve Meta en su error 400', () => {
    expect([...META_AUDIO_MIME].sort()).toEqual(
      ['audio/aac', 'audio/amr', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/opus'].sort(),
    );
  });
});

describe.skipIf(!HAY_FFMPEG)('conversión real (necesita ffmpeg)', () => {
  it('un WebM grabado por el navegador se convierte a Ogg/Opus', async () => {
    const webm = generar('grabacion.webm', ['-c:a', 'libopus', '-b:a', '24k', '-f', 'webm']);
    const resultado = await normalizeAudio({ buffer: webm, mimeType: 'audio/webm', filename: 'nota.webm' });
    expect(resultado.ok).toBe(true);
    expect(resultado.converted).toBe(true);
    expect(resultado.mimeType).toBe(NORMALIZED_MIME);
    // El archivo que sale es un Ogg de verdad con Opus dentro.
    expect(resultado.buffer.subarray(0, 4).toString('ascii')).toBe('OggS');
    expect(resultado.buffer.includes('OpusHead')).toBe(true);
    expect(resultado.buffer.length).toBeGreaterThan(0);
    // Y se sabe cuánto dura: es lo que se registra en el log.
    expect(resultado.probe?.durationMs).toBeGreaterThan(0);
  }, 20000);

  it('un Ogg con Vorbis también se convierte (Meta solo admite Opus en Ogg)', async () => {
    const vorbis = generar('vorbis.ogg', ['-c:a', 'libvorbis', '-b:a', '64k']);
    const resultado = await normalizeAudio({ buffer: vorbis, mimeType: 'audio/ogg', filename: 'voz.ogg' });
    expect(resultado.ok).toBe(true);
    expect(resultado.converted).toBe(true);
    expect(resultado.codec).toBe('vorbis');
    expect(resultado.buffer.includes('OpusHead')).toBe(true);
  }, 20000);

  it('un MP3 válido NO se toca (no se convierte de más)', async () => {
    const mp3 = generar('tono.mp3', ['-c:a', 'libmp3lame', '-b:a', '64k']);
    const resultado = await normalizeAudio({ buffer: mp3, mimeType: 'audio/mpeg', filename: 'tono.mp3' });
    expect(resultado.ok).toBe(true);
    expect(resultado.converted).toBe(false);
    expect(resultado.buffer).toBe(mp3);
  }, 20000);

  it('lo que no es audio no se convierte en un éxito falso', async () => {
    const basura = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(200, 9)]);
    const resultado = await normalizeAudio({ buffer: basura, mimeType: 'audio/ogg' });
    // Un Ogg ilegible se deja pasar (no se intenta convertir), así que no falla…
    expect(resultado.ok).toBe(true);
    expect(resultado.converted).toBe(false);
    // …pero un WebM corrupto SÍ intenta convertirse y falla con un código claro.
    const roto = await normalizeAudio({ buffer: WEBM, mimeType: 'audio/webm' });
    expect(roto.ok).toBe(false);
    expect(['convert_failed', 'convert_timeout', 'convert_empty']).toContain(roto.error.code);
  }, 20000);

  it('no deja archivos temporales detrás (ni cuando la conversión falla)', async () => {
    // Carpeta propia: así se mide lo de ESTE test y no lo de otros ficheros que
    // corren en paralelo con el mismo `/tmp`.
    const sucio = mkdtempSync(path.join(tmp, 'temporal-'));
    const webm = generar('limpieza.webm', ['-c:a', 'libopus', '-b:a', '24k', '-f', 'webm']);

    const ok = await normalizeAudio({ buffer: webm, mimeType: 'audio/webm', tmpDir: sucio });
    expect(ok.ok).toBe(true);
    const fallo = await normalizeAudio({ buffer: WEBM, mimeType: 'audio/webm', tmpDir: sucio });
    expect(fallo.ok).toBe(false);

    expect(readdirSync(sucio)).toEqual([]);
  }, 20000);
});

describe('sin conversor disponible', () => {
  it('devuelve «converter_missing» con un mensaje útil, nunca un éxito falso', async () => {
    const original = process.env.PATH;
    process.env.PATH = path.join(tmp, 'sin-binarios');
    resetFfmpegCache();
    try {
      expect(ffmpegInfo().available).toBe(false);
      const webm = await normalizeAudio({ buffer: WEBM, mimeType: 'audio/webm' });
      expect(webm.ok).toBe(false);
      expect(webm.error.code).toBe('converter_missing');
      expect(webm.error.message).toMatch(/OGG|M4A|MP3/);

      const vorbis = await normalizeAudio({ buffer: OGG_VORBIS, mimeType: 'audio/ogg' });
      expect(vorbis.ok).toBe(false);
      expect(vorbis.error.code).toBe('converter_missing');
      expect(vorbis.error.message).toMatch(/Vorbis|Opus/i);
    } finally {
      process.env.PATH = original;
      resetFfmpegCache();
    }
  });
});
