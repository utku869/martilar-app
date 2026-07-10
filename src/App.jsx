import { useState, useRef, useEffect, useCallback } from "react";
import logoUrl from "./assets/logo.jpg";

// ─── ENSTRÜMANLAR ────────────────────────────────────────────────────────────
const INSTRUMENTS = {
  solist: { label: "Solist", icon: "🎤", color: "#E8C97E" },
  gitarist: { label: "Gitar", icon: "🎸", color: "#C0956C" },
  bassist: { label: "Bass", icon: "🎛️", color: "#7EB8C9" },
  baterist: { label: "Bateri", icon: "🥁", color: "#C97E7E" },
  klavye: { label: "Klavye", icon: "🎹", color: "#9E7EC9" },
  klarnet: { label: "Klarnet", icon: "🎶", color: "#7EC97E" },
};
const PART_ORDER = ["solist", "gitarist", "bassist", "baterist", "klavye", "klarnet"];
const NOTE_NAMES = ["Do", "Do#", "Re", "Re#", "Mi", "Fa", "Fa#", "Sol", "Sol#", "La", "La#", "Si"];

// Depolama — Claude artifact ortamında window.storage, dışarıda localStorage kullanılır
// shared=true: uygulamayı kullanan herkesin erişebildiği alan (oda senkronu için)
const storage = {
  async get(key, shared = false) {
    if (typeof window !== "undefined" && window.storage?.get) {
      try { return await window.storage.get(key, shared); } catch { /* düş */ }
    }
    try { const v = localStorage.getItem((shared ? "S:" : "") + key); return v == null ? null : { value: v }; }
    catch { return null; }
  },
  async set(key, value, shared = false) {
    if (typeof window !== "undefined" && window.storage?.set) {
      try { const r = await window.storage.set(key, value, shared); if (r) return r; } catch { /* düş */ }
    }
    try { localStorage.setItem((shared ? "S:" : "") + key, value); return { value }; } catch { return null; }
  },
  async delete(key, shared = false) {
    if (typeof window !== "undefined" && window.storage?.delete) {
      try { await window.storage.delete(key, shared); } catch { /* düş */ }
    }
    try { localStorage.removeItem((shared ? "S:" : "") + key); return { deleted: true }; } catch { return null; }
  },
};

// ─── VARSAYILAN ŞARKILAR ─────────────────────────────────────────────────────
const DEFAULT_SONGS = [];

// Metronom ses tipleri
const CLICK_TYPES = [
  { id: "bip", label: "Bip" },
  { id: "klik", label: "Klik" },
  { id: "tahta", label: "Tahta" },
  { id: "tik", label: "Tık" },
];
function playClick(ctx, accent, type = "bip", vol = 0.5) {
  const t = ctx.currentTime;
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  if (type === "klik") {
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.03), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = "highpass";
    f.frequency.value = accent ? 3200 : 2200;
    gain.gain.setValueAtTime(vol, t);
    src.connect(f).connect(gain);
    src.start();
    return;
  }
  const osc = ctx.createOscillator();
  if (type === "tahta") {
    osc.type = "triangle";
    osc.frequency.value = accent ? 2100 : 1600;
    gain.gain.setValueAtTime(Math.min(1, vol * 1.2), t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.045);
    osc.connect(gain); osc.start(); osc.stop(t + 0.05);
  } else if (type === "tik") {
    osc.type = "square";
    osc.frequency.value = accent ? 4000 : 3200;
    gain.gain.setValueAtTime(vol * 0.35, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.02);
    osc.connect(gain); osc.start(); osc.stop(t + 0.025);
  } else {
    osc.type = "sine";
    osc.frequency.value = accent ? 1320 : 880;
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    osc.connect(gain); osc.start(); osc.stop(t + 0.09);
  }
}

// ─── PITCH DETECTION (autocorrelation) ───────────────────────────────────────
function autoCorrelate(buf, sampleRate) {
  let rms = 0;
  for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / buf.length);
  if (rms < 0.012) return { freq: -1, rms };

  let r1 = 0, r2 = buf.length - 1;
  const thres = 0.2;
  for (let i = 0; i < buf.length / 2; i++) if (Math.abs(buf[i]) < thres) { r1 = i; break; }
  for (let i = 1; i < buf.length / 2; i++) if (Math.abs(buf[buf.length - i]) < thres) { r2 = buf.length - i; break; }
  const b = buf.slice(r1, r2);
  const N = b.length;
  if (N < 64) return { freq: -1, rms };

  const c = new Array(N).fill(0);
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N - i; j++) c[i] += b[j] * b[j + i];

  let d = 0;
  while (d < N - 1 && c[d] > c[d + 1]) d++;
  let maxval = -1, maxpos = -1;
  for (let i = d; i < N; i++) if (c[i] > maxval) { maxval = c[i]; maxpos = i; }
  if (maxpos <= 0) return { freq: -1, rms };

  let T0 = maxpos;
  const x1 = c[T0 - 1], x2 = c[T0], x3 = c[T0 + 1] || x2;
  const a = (x1 + x3 - 2 * x2) / 2, bb = (x3 - x1) / 2;
  if (a) T0 = T0 - bb / (2 * a);

  const freq = sampleRate / T0;
  if (freq < 50 || freq > 2200) return { freq: -1, rms };
  return { freq, rms };
}

function freqToMidi(freq) {
  return Math.round(12 * Math.log2(freq / 440) + 69);
}
function freqToNote(freq) {
  const midi = freqToMidi(freq);
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

// "La2 La2 Do3 Sol2" veya "A2 A2 C3 G2" → hedef nota dizisi (pitch class)
const TR_TO_PC = { do: 0, re: 2, mi: 4, fa: 5, sol: 7, la: 9, si: 11 };
const EN_TO_PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
function parseNoteSeq(text) {
  if (!text) return [];
  const out = [];
  for (const raw of text.split(/[\s,;|]+/)) {
    if (!raw) continue;
    const m = raw.toLowerCase().match(/^(do|re|mi|fa|sol|la|si|[a-g])(#|b)?(\d)?$/);
    if (!m) continue;
    let pc = m[1].length > 1 ? TR_TO_PC[m[1]] : EN_TO_PC[m[1]];
    if (pc === undefined) continue;
    if (m[2] === "#") pc = (pc + 1) % 12;
    if (m[2] === "b") pc = (pc + 11) % 12;
    out.push({ pc, label: raw });
  }
  return out;
}

// ─── MIDI PARSER (Standard MIDI File) ────────────────────────────────────────
function parseMidi(buffer) {
  const data = new DataView(buffer);
  let pos = 0;
  const readStr = (n) => { let s = ""; for (let i = 0; i < n; i++) s += String.fromCharCode(data.getUint8(pos++)); return s; };
  const read32 = () => { const v = data.getUint32(pos); pos += 4; return v; };
  const read16 = () => { const v = data.getUint16(pos); pos += 2; return v; };
  const read8 = () => data.getUint8(pos++);
  const readVar = () => { let v = 0, b; do { b = read8(); v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };

  if (readStr(4) !== "MThd") throw new Error("Geçerli bir MIDI dosyası değil");
  read32();
  read16(); // format
  const nTracks = read16();
  const division = read16();
  if (division & 0x8000) throw new Error("SMPTE zamanlı MIDI desteklenmiyor");

  let microPerQuarter = 500000;
  let timeSig = [4, 4];
  const tracks = [];
  const lyrics = []; // {tick, text} — dosya genelinde toplu

  for (let t = 0; t < nTracks; t++) {
    if (readStr(4) !== "MTrk") throw new Error("Track okunamadı");
    const len = read32();
    const end = pos + len;
    let tick = 0, running = 0, name = "";
    const notes = [];
    const open = {};
    let channelSeen = null;
    while (pos < end) {
      tick += readVar();
      let status = read8();
      if (status < 0x80) { pos--; status = running; } else running = status;
      const type = status & 0xf0, ch = status & 0x0f;
      if (status === 0xff) {
        const meta = read8(); const mlen = readVar();
        if (meta === 0x03) { name = ""; for (let i = 0; i < mlen; i++) name += String.fromCharCode(read8()); }
        else if (meta === 0x05 || meta === 0x01) {
          // Lyric (0x05) veya Text (0x01) — karaoke sözleri buradan gelir
          let txt = "";
          for (let i = 0; i < mlen; i++) txt += String.fromCharCode(read8());
          // Karaoke başlıklarını atla: @KMIDI, @T, @L gibi
          if (meta === 0x05 || (meta === 0x01 && !/^@[A-Z]/.test(txt) && txt.trim())) {
            lyrics.push({ tick, text: txt });
          }
        }
        else if (meta === 0x51 && mlen === 3) { microPerQuarter = (read8() << 16) | (read8() << 8) | read8(); }
        else if (meta === 0x58 && mlen >= 2) { const nn = read8(), dd = read8(); pos += mlen - 2; timeSig = [nn, Math.pow(2, dd)]; }
        else pos += mlen;
      } else if (status === 0xf0 || status === 0xf7) {
        pos += readVar();
      } else if (type === 0x90 || type === 0x80) {
        const note = read8(), vel = read8();
        channelSeen = ch;
        if (type === 0x90 && vel > 0) { if (open[note] === undefined) open[note] = tick; }
        else if (open[note] !== undefined) {
          notes.push({ midi: note, startTick: open[note], durTick: tick - open[note] });
          delete open[note];
        }
      } else if (type === 0xa0 || type === 0xb0 || type === 0xe0) pos += 2;
      else if (type === 0xc0 || type === 0xd0) pos += 1;
    }
    pos = end;
    if (notes.length) tracks.push({ name: name.trim() || `Track ${t + 1}`, channel: channelSeen, notes });
  }
  return { bpm: Math.round(60000000 / microPerQuarter), timeSig: `${timeSig[0]}/${timeSig[1]}`, division, tracks, lyrics };
}

// Karaoke sözlerini bar bazlı metne çevir
function lyricsToPart(lyrics, ticksPerBar) {
  if (!lyrics.length) return null;
  const sorted = [...lyrics].sort((a, b) => a.tick - b.tick);
  const bars = new Map();
  for (const l of sorted) {
    const b = Math.floor(l.tick / ticksPerBar) + 1;
    // Karaoke konvansiyonu: '\' = paragraf, '/' = satır sonu
    let t = l.text.replace(/\r/g, "");
    if (t.startsWith("\\")) t = "\n\n" + t.slice(1);
    else if (t.startsWith("/")) t = "\n" + t.slice(1);
    if (!bars.has(b)) bars.set(b, "");
    bars.set(b, bars.get(b) + t);
  }
  const maxBar = Math.max(...bars.keys());
  const lines = [];
  for (let b = 1; b <= maxBar; b++) {
    const marker = `[${String(b).padStart(3, " ")}]`;
    if (bars.has(b)) {
      const clean = bars.get(b).replace(/\n{3,}/g, "\n\n").trim();
      lines.push(`${marker}  ${clean}`);
    } else {
      lines.push(marker); // boş bar — satır sayısı bar sayısına eşit kalsın diye
    }
  }
  return lines.join("\n");
}

const DRUM_MAP = { 35: "Kick", 36: "Kick", 37: "Rim", 38: "Snare", 39: "Clap", 40: "Snare", 41: "TomD", 42: "HH", 43: "TomD", 44: "HHped", 45: "Tom", 46: "HHaçık", 47: "Tom", 48: "Tom", 49: "Crash", 50: "Tom", 51: "Ride", 52: "China", 53: "RideBell", 55: "Splash", 57: "Crash2", 59: "Ride2" };

function midiToName(m) {
  return `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

// Track → partisyon içeriği: her satır bir bar (takip çizgisi senkronu için)
function trackToPart(track, ticksPerBar, isDrum) {
  const sorted = [...track.notes].sort((a, b) => a.startTick - b.startTick);
  const bars = new Map();
  for (const n of sorted) {
    const b = Math.floor(n.startTick / ticksPerBar) + 1;
    if (!bars.has(b)) bars.set(b, []);
    bars.get(b).push(isDrum ? (DRUM_MAP[n.midi] || `P${n.midi}`) : midiToName(n.midi));
  }
  const maxBar = Math.max(...bars.keys());
  const lines = [];
  for (let b = 1; b <= maxBar; b++) {
    lines.push(`[${String(b).padStart(3, " ")}]  ${(bars.get(b) || ["·"]).join("  ")}`);
  }
  const practiceNotes = isDrum ? "" : sorted.slice(0, 300).map((n) => midiToName(n.midi)).join(" ");
  const events = sorted.map((n) => ({ m: n.midi, s: n.startTick, d: n.durTick }));
  return { content: lines.join("\n"), practiceNotes, events };
}

function guessInstrument(tr) {
  if (tr.channel === 9) return "baterist";
  const n = (tr.name || "").toLowerCase();
  if (n.includes("bass") || n.includes("bas ")) return "bassist";
  if (n.includes("guit") || n.includes("gitar")) return "gitarist";
  if (n.includes("piano") || n.includes("key") || n.includes("klavye") || n.includes("organ") || n.includes("synth")) return "klavye";
  if (n.includes("voc") || n.includes("vok") || n.includes("melody") || n.includes("lead") || n.includes("sing") || n.includes("solist")) return "solist";
  if (n.includes("clar") || n.includes("klarnet")) return "klarnet";
  return "";
}

// ─── ANA UYGULAMA ────────────────────────────────────────────────────────────
export default function MartilarApp() {
  const [screen, setScreen] = useState("home");
  const [songs, setSongs] = useState(DEFAULT_SONGS);
  const [songId, setSongId] = useState(null);
  const [part, setPart] = useState(null);
  const [fontSize, setFontSize] = useState(14);
  const [query, setQuery] = useState("");
  const [metroOpen, setMetroOpen] = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  const [midiOpen, setMidiOpen] = useState(false);
  const [roomJoinOpen, setRoomJoinOpen] = useState(false);
  const [room, setRoom] = useState(null); // { code, role: "host"|"member", songId? }
  const [roomData, setRoomData] = useState(null); // member: { song, transport }
  const roomSongRef = useRef(null); // host: odaya yazılan şarkı anlık görüntüsü
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      let custom = [];
      try {
        const r = await storage.get("martilar-custom-songs");
        if (r?.value) {
          custom = JSON.parse(r.value);
          console.log("[yükleme] custom şarkılar:", custom.length);
        }
      } catch { console.log("[yükleme] kayıtlı custom şarkı yok"); }
      const all = [...custom, ...DEFAULT_SONGS].map((s) => ({ ...s, parts: { ...s.parts } }));
      for (const s of all) {
        try {
          const r = await storage.get(`martilar-song-${s.id}`);
          if (r?.value) {
            const saved = JSON.parse(r.value);
            for (const k of Object.keys(saved.parts || {})) s.parts[k] = saved.parts[k];
            if (s.id.startsWith("custom-")) console.log("[yükleme] parts geri yüklendi:", s.title);
          } else if (s.id.startsWith("custom-")) {
            console.warn("[yükleme] custom şarkı bulundu ama partisyon verisi yok:", s.title);
          }
        } catch { /* varsayılan şarkılarda normal */ }
      }
      setSongs(all);
      setLoaded(true);
    })();
  }, []);

  const song = songId === "room"
    ? (roomData?.song ? { ...roomData.song, id: "room" } : null)
    : songs.find((s) => s.id === songId) || null;

  const savePart = useCallback((sid, pkey, content, notes, practiceNotes) => {
    setSongs((prev) => {
      const next = prev.map((s) => {
        if (s.id !== sid) return s;
        const existing = s.parts[pkey] || {};
        // MIDI'den gelen events/ticksPerBar/division/synced alanlarını KORU
        const merged = { ...existing, content, notes: notes || "", practiceNotes: practiceNotes || "" };
        return { ...s, parts: { ...s.parts, [pkey]: merged } };
      });
      const target = next.find((s) => s.id === sid);
      const payload = { parts: {} };
      for (const [k, v] of Object.entries(target.parts)) if (v?.content) payload.parts[k] = v;
      storage.set(`martilar-song-${sid}`, JSON.stringify(payload))
        .then((r) => { if (!r) console.error("[savePart] kayıt başarısız", sid); })
        .catch((e) => console.error("[savePart] hata", sid, e));
      return next;
    });
  }, []);

  const addSong = useCallback((meta) => {
    const id = "custom-" + Date.now();
    const parts = {};
    for (const p of meta.instruments) parts[p] = null;
    const newSong = { id, title: meta.title, artist: meta.artist || "Martılar", key: meta.key || "—", tempo: meta.tempo || 100, time: meta.time || "4/4", tags: ["kendi eklediğimiz"], parts };
    setSongs((prev) => {
      const next = [newSong, ...prev];
      const customs = next.filter((s) => s.id.startsWith("custom-")).map(({ id, title, artist, key, tempo, time, tags, parts }) => ({
        id, title, artist, key, tempo, time, tags,
        parts: Object.fromEntries(Object.keys(parts).map((k) => [k, null])),
      }));
      storage.set("martilar-custom-songs", JSON.stringify(customs)).catch(() => {});
      return next;
    });
    setAddOpen(false);
    setSongId(id);
    setPart(null);
    setScreen("song");
  }, []);

  const addMidiSong = useCallback(({ title, artist, parsed, assign }) => {
    const num = parseInt(parsed.timeSig.split("/")[0], 10) || 4;
    const den = parseInt(parsed.timeSig.split("/")[1], 10) || 4;
    const ticksPerBar = parsed.division * 4 * (num / den);
    const parts = {};
    // Sözler varsa solist için ayıralım
    const lyricsContent = parsed.lyrics?.length ? lyricsToPart(parsed.lyrics, ticksPerBar) : null;
    parsed.tracks.forEach((tr, i) => {
      const instKey = assign[i];
      if (!instKey) return;
      // Solist için sözler varsa notalar yerine sözleri koy
      if (instKey === "solist" && lyricsContent) {
        if (!parts.solist) {
          parts.solist = { content: lyricsContent, notes: "MIDI sözlerinden içe aktarıldı", practiceNotes: "", synced: true };
        }
        return;
      }
      const isDrum = tr.channel === 9 || instKey === "baterist";
      const gen = trackToPart(tr, ticksPerBar, isDrum);
      if (parts[instKey]) {
        parts[instKey].content += "\n\n[— diğer track —]\n" + gen.content;
        if (gen.practiceNotes && !parts[instKey].practiceNotes) parts[instKey].practiceNotes = gen.practiceNotes;
      } else {
        parts[instKey] = { content: gen.content, notes: "MIDI'den içe aktarıldı", practiceNotes: gen.practiceNotes, synced: true, events: gen.events, ticksPerBar, division: parsed.division };
      }
    });
    // Solist atanmadıysa ama sözler varsa yine de solist partı oluştur
    if (!parts.solist && lyricsContent) {
      parts.solist = { content: lyricsContent, notes: "MIDI sözlerinden içe aktarıldı", practiceNotes: "" };
    }

    // Aynı ad+sanatçıda varolan şarkıyı bul → üstüne yaz, yenisini eklemek yerine
    setSongs((prev) => {
      const norm = (x) => (x || "").trim().toLowerCase();
      const existing = prev.find((s) => s.id.startsWith("custom-") && norm(s.title) === norm(title) && norm(s.artist) === norm(artist || "Martılar"));
      const id = existing ? existing.id : "custom-" + Date.now();
      const newSong = { id, title, artist: artist || "Martılar", key: existing?.key || "—", tempo: parsed.bpm, time: parsed.timeSig, tags: ["midi"], parts };
      const next = existing ? prev.map((s) => (s.id === id ? newSong : s)) : [newSong, ...prev];

      const customs = next.filter((s) => s.id.startsWith("custom-")).map(({ id, title, artist, key, tempo, time, tags, parts }) => ({
        id, title, artist, key, tempo, time, tags,
        parts: Object.fromEntries(Object.keys(parts).map((k) => [k, null])),
      }));
      const partsPayload = { parts };

      // Önce parts, sonra liste — kısmi kayıt olsa bile liste tutarlı kalır
      Promise.all([
        storage.set(`martilar-song-${id}`, JSON.stringify(partsPayload)),
        storage.set("martilar-custom-songs", JSON.stringify(customs)),
      ])
        .then(([a, b]) => {
          if (!a || !b) console.error("[MIDI kaydet] eksik dönüş", { a: !!a, b: !!b });
          else console.log("[MIDI kaydet] tamam", id, `${JSON.stringify(partsPayload).length} bayt`);
        })
        .catch((e) => console.error("[MIDI kaydet] hata — muhtemelen dosya çok büyük", e));

      setSongId(id);
      return next;
    });
    setMidiOpen(false);
    setPart(null);
    setScreen("song");
  }, []);

  const deleteSong = useCallback((sid) => {
    setSongs((prev) => {
      const next = prev.filter((s) => s.id !== sid);
      const customs = next.filter((s) => s.id.startsWith("custom-")).map(({ id, title, artist, key, tempo, time, tags, parts }) => ({
        id, title, artist, key, tempo, time, tags,
        parts: Object.fromEntries(Object.keys(parts).map((k) => [k, null])),
      }));
      storage.set("martilar-custom-songs", JSON.stringify(customs)).catch((e) => console.error("[sil] liste güncellenemedi", e));
      storage.delete(`martilar-song-${sid}`).catch((e) => console.error("[sil] partisyon verisi silinemedi", e));
      return next;
    });
    if (songId === sid) {
      setSongId(null);
      setScreen("list");
    }
  }, [songId]);

  // ─── ODA (stüdyo senkronu — paylaşımlı depolama üzerinden) ───
  const createRoom = useCallback(async (songObj) => {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    const snapshot = JSON.parse(JSON.stringify(songObj)); // parts + events dahil
    roomSongRef.current = snapshot;
    const payload = {
      song: snapshot,
      transport: { playing: false, startTick: 0, epoch: Date.now(), speed: 1, loopStart: 0, loopBars: 0 },
      updatedAt: Date.now(),
    };
    const r = await storage.set(`martilar-room-${code}`, JSON.stringify(payload), true);
    if (!r) { console.error("[oda] oluşturulamadı — veri çok büyük olabilir"); return null; }
    setRoom({ code, role: "host", songId: songObj.id });
    return code;
  }, []);

  const pushTransport = useCallback((transport) => {
    setRoom((cur) => {
      if (cur?.role === "host" && roomSongRef.current) {
        storage.set(`martilar-room-${cur.code}`, JSON.stringify({
          song: roomSongRef.current, transport, updatedAt: Date.now(),
        }), true).catch((e) => console.error("[oda] transport yazılamadı", e));
      }
      return cur;
    });
  }, []);

  const closeRoom = useCallback(() => {
    setRoom((cur) => {
      if (cur) storage.delete(`martilar-room-${cur.code}`, true).catch(() => {});
      return null;
    });
    setRoomData(null);
    roomSongRef.current = null;
  }, []);

  const joinRoom = useCallback(async (code) => {
    const clean = code.trim().toUpperCase();
    try {
      const r = await storage.get(`martilar-room-${clean}`, true);
      if (!r?.value) return "Oda bulunamadı — kodu kontrol edin";
      setRoomData(JSON.parse(r.value));
      setRoom({ code: clean, role: "member" });
      setRoomJoinOpen(false);
      setSongId("room");
      setPart(null);
      setScreen("song");
      return null;
    } catch {
      return "Odaya bağlanılamadı";
    }
  }, []);

  // Üye: oda durumunu düzenli aralıkla çek
  useEffect(() => {
    if (!room || room.role !== "member") return;
    const iv = setInterval(async () => {
      try {
        const r = await storage.get(`martilar-room-${room.code}`, true);
        if (r?.value) setRoomData(JSON.parse(r.value));
        else { // oda kapatıldı
          setRoom(null); setRoomData(null); setSongId(null); setScreen("list");
        }
      } catch { /* geçici ağ hatası — bir sonraki turda dener */ }
    }, 1200);
    return () => clearInterval(iv);
  }, [room]);

  const filtered = songs.filter(
    (s) => s.title.toLowerCase().includes(query.toLowerCase()) ||
      (s.artist || "").toLowerCase().includes(query.toLowerCase()) ||
      s.tags.some((t) => t.includes(query.toLowerCase()))
  );
  const availableParts = song ? PART_ORDER.filter((p) => p in song.parts) : [];

  return (
    <div style={st.frame}>
      <style>{css}</style>
      <div style={st.phone}>
        <div style={st.screen}>
          {!loaded && <div style={st.loading}>Yükleniyor…</div>}

          {loaded && screen === "home" && <Home onEnter={() => setScreen("list")} />}

          {loaded && screen === "list" && (
            <SongList songs={filtered} query={query} setQuery={setQuery}
              onPick={(s) => { setSongId(s.id); setPart(null); setScreen("song"); }}
              onBack={() => setScreen("home")} onAdd={() => setAddOpen(true)} onMidi={() => setMidiOpen(true)} onDelete={deleteSong}
              onJoinRoom={() => setRoomJoinOpen(true)} />
          )}

          {loaded && screen === "song" && song && (
            <SongDetail song={song} parts={availableParts}
              onPickPart={(p) => { setPart(p); setScreen("part"); }}
              onBack={() => { if (songId === "room") { closeRoom(); setSongId(null); } setScreen("list"); }}
              onMetro={() => setMetroOpen(true)}
              room={room} onCreateRoom={createRoom} onCloseRoom={closeRoom} />
          )}

          {loaded && screen === "part" && song && part && (
            <PartView song={song} part={part} allParts={availableParts}
              fontSize={fontSize} setFontSize={setFontSize}
              onChangePart={setPart} onBack={() => setScreen("song")}
              onMetro={() => setMetroOpen(true)}
              onSave={savePart}
              roomRole={room ? (room.role === "member" && songId === "room" ? "member" : room.role === "host" && songId === room.songId ? "host" : null) : null}
              roomCode={room?.code}
              transport={roomData?.transport}
              onTransport={pushTransport} />
          )}

          {metroOpen && song && <Metronome song={song} onClose={() => setMetroOpen(false)} />}
          {addOpen && <AddSong onAdd={addSong} onClose={() => setAddOpen(false)} />}
          {midiOpen && <MidiImport onCreate={addMidiSong} onClose={() => setMidiOpen(false)} />}
          {roomJoinOpen && <RoomJoin onJoin={joinRoom} onClose={() => setRoomJoinOpen(false)} />}
        </div>
        <div style={{ height: 24 }} />
      </div>
    </div>
  );
}

// ─── ANA SAYFA ───────────────────────────────────────────────────────────────
function Home({ onEnter }) {
  return (
    <div style={st.home}>
      <div style={st.homeGlow} />
      <div className="gull-ring" style={st.ring} />
      <div className="gull-ring" style={{ ...st.ring, animationDelay: "1.3s" }} />
      <div style={{ textAlign: "center", zIndex: 1, width: "100%" }}>
        <img src={logoUrl} alt="Martılar Fusion"
          style={{ width: "62%", maxWidth: 240, borderRadius: 16, boxShadow: "0 10px 30px rgba(0,0,0,.5), 0 0 0 1px #ffffff0c", display: "block", margin: "0 auto" }} />
        <p style={st.tagline}>Sahne Defteri</p>
        <div style={st.divider} />
        <p style={st.desc}>Tablar · Akış · Metronom · Pratik Puanı</p>
        <button style={st.enterBtn} onClick={onEnter}>Şarkılara Git <span style={{ fontSize: 20 }}>›</span></button>
      </div>
      <div style={st.crewRow}>
        {["solist", "gitarist", "bassist", "baterist", "klavye"].map((k) => (
          <span key={k} style={{ fontSize: 18, opacity: 0.75 }}>{INSTRUMENTS[k].icon}</span>
        ))}
      </div>
    </div>
  );
}

// ─── ŞARKI LİSTESİ ───────────────────────────────────────────────────────────
function SongList({ songs, query, setQuery, onPick, onBack, onAdd, onMidi, onDelete, onJoinRoom }) {
  return (
    <div style={st.col}>
      <div style={st.header}>
        <button style={st.back} onClick={onBack}>‹</button>
        <h2 style={st.hTitle}>Repertuvar</h2>
        <button style={st.addBtn} onClick={onJoinRoom}>📡 Katıl</button>
        <button style={st.addBtn} onClick={onMidi}>🎼 MIDI</button>
        <button style={st.addBtn} onClick={onAdd}>+ Şarkı</button>
      </div>
      <div style={st.search}>
        <span style={{ color: "#666", fontSize: 16 }}>⌕</span>
        <input style={st.searchInput} placeholder="Şarkı, sanatçı ara…" value={query} onChange={(e) => setQuery(e.target.value)} />
        {query && <button style={st.clear} onClick={() => setQuery("")}>×</button>}
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 14px 14px" }}>
        {songs.map((s, i) => {
          const ready = Object.values(s.parts).filter((p) => p?.content).length;
          const total = Object.keys(s.parts).length;
          const isCustom = s.id.startsWith("custom-");
          return (
            <div key={s.id} style={{ position: "relative" }}>
              <button style={st.card} onClick={() => onPick(s)}>
                <div style={{ display: "flex", gap: 12, flex: 1 }}>
                  <span style={st.num}>{String(i + 1).padStart(2, "0")}</span>
                  <div style={{ flex: 1 }}>
                    <div style={st.cardTitle}>{s.title}</div>
                    <div style={st.cardArtist}>{s.artist}</div>
                    <div style={st.cardMeta}>{s.key} · {s.tempo} BPM · {s.time}</div>
                    <div style={{ display: "flex", gap: 4, marginTop: 5, flexWrap: "wrap" }}>
                      {s.tags.map((t) => <span key={t} style={st.tag}>{t}</span>)}
                    </div>
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ ...st.readiness, color: ready === total ? "#7EC97E" : "#E8C97E" }}>{ready}/{total}</div>
                  <div style={{ color: "#E8C97E", fontSize: 18 }}>›</div>
                </div>
              </button>
              {isCustom && onDelete && (
                <button
                  title="Şarkıyı sil"
                  style={st.deleteBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(`"${s.title}" silinsin mi? Bu işlem geri alınamaz.`)) onDelete(s.id);
                  }}>
                  ×
                </button>
              )}
            </div>
          );
        })}
        {songs.length === 0 && <div style={st.empty}>Sonuç yok</div>}
      </div>
    </div>
  );
}

// ─── ŞARKI EKLEME ────────────────────────────────────────────────────────────
function AddSong({ onAdd, onClose }) {
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [key, setKey] = useState("");
  const [tempo, setTempo] = useState(100);
  const [time, setTime] = useState("4/4");
  const [insts, setInsts] = useState(["solist", "gitarist", "bassist", "baterist", "klavye"]);

  const toggle = (k) => setInsts((p) => p.includes(k) ? p.filter((x) => x !== k) : [...p, k]);

  return (
    <div style={st.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={st.sheet}>
        <div style={st.sheetHandle} />
        <div style={st.sheetTitle}>Yeni Şarkı</div>
        <input style={st.formInput} placeholder="Şarkı adı *" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input style={st.formInput} placeholder="Sanatçı" value={artist} onChange={(e) => setArtist(e.target.value)} />
        <div style={{ display: "flex", gap: 8 }}>
          <input style={{ ...st.formInput, flex: 1 }} placeholder="Ton (ör. La Minör)" value={key} onChange={(e) => setKey(e.target.value)} />
          <input style={{ ...st.formInput, width: 70 }} type="number" placeholder="BPM" value={tempo} onChange={(e) => setTempo(parseInt(e.target.value) || 100)} />
          <select style={{ ...st.formInput, width: 70 }} value={time} onChange={(e) => setTime(e.target.value)}>
            {["4/4", "3/4", "6/8", "2/4", "5/4", "7/8", "9/8"].map((t) => <option key={t}>{t}</option>)}
          </select>
        </div>
        <div style={{ fontSize: 10, color: "#666", letterSpacing: 2, textTransform: "uppercase", margin: "10px 0 6px", fontFamily: "monospace" }}>Partisyonlar</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {PART_ORDER.map((k) => (
            <button key={k} onClick={() => toggle(k)}
              style={{ ...st.instChip, borderColor: insts.includes(k) ? INSTRUMENTS[k].color : "#ffffff15", opacity: insts.includes(k) ? 1 : 0.45, color: insts.includes(k) ? INSTRUMENTS[k].color : "#888" }}>
              {INSTRUMENTS[k].icon} {INSTRUMENTS[k].label}
            </button>
          ))}
        </div>
        <button style={{ ...st.saveBtn, marginTop: 16, opacity: title.trim() && insts.length ? 1 : 0.4 }}
          onClick={() => title.trim() && insts.length && onAdd({ title: title.trim(), artist: artist.trim(), key: key.trim(), tempo, time, instruments: insts })}>
          Şarkıyı Oluştur
        </button>
        <button style={st.sheetClose} onClick={onClose}>Vazgeç</button>
      </div>
    </div>
  );
}

// ─── MIDI İÇE AKTARMA ────────────────────────────────────────────────────────
function MidiImport({ onCreate, onClose }) {
  const [stage, setStage] = useState("pick"); // pick | assign | error
  const [err, setErr] = useState("");
  const [parsed, setParsed] = useState(null);
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [assign, setAssign] = useState({});
  const fileRef = useRef(null);

  const handleFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setTitle(f.name.replace(/\.(midi?|MIDI?)$/, "").replace(/[_-]+/g, " ").trim());
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const p = parseMidi(reader.result);
        if (!p.tracks.length) throw new Error("nota içeren track bulunamadı");
        const a = {};
        p.tracks.forEach((tr, i) => { a[i] = guessInstrument(tr); });
        setAssign(a);
        setParsed(p);
        setStage("assign");
      } catch (ex) {
        setErr("MIDI okunamadı: " + ex.message);
        setStage("error");
      }
    };
    reader.onerror = () => { setErr("Dosya okunamadı"); setStage("error"); };
    reader.readAsArrayBuffer(f);
  };

  const canCreate = title.trim() && Object.values(assign).some(Boolean);

  return (
    <div style={st.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={st.sheet}>
        <div style={st.sheetHandle} />
        <div style={st.sheetTitle}>🎼 MIDI İçe Aktar</div>

        {stage === "pick" && (
          <>
            <p style={{ color: "#999", fontSize: 12, lineHeight: 1.7, textAlign: "center", margin: "16px 6px" }}>
              Bir .mid dosyası seçin. Trackler notaya çevrilir, her track bir partisyona atanır.
              Pratik modu nota karşılaştırmasını bu veriden otomatik yapar ve takip çizgisi bar bar
              senkron akar.
            </p>
            <button style={st.bigBtn} onClick={() => fileRef.current?.click()}>Dosya Seç (.mid)</button>
            <input ref={fileRef} type="file" accept=".mid,.midi,audio/midi" style={{ display: "none" }} onChange={handleFile} />
          </>
        )}

        {stage === "assign" && parsed && (
          <>
            <input style={st.formInput} placeholder="Şarkı adı *" value={title} onChange={(e) => setTitle(e.target.value)} />
            <input style={st.formInput} placeholder="Sanatçı" value={artist} onChange={(e) => setArtist(e.target.value)} />
            <div style={{ display: "flex", gap: 6, margin: "12px 0 4px", justifyContent: "center" }}>
              <span style={st.pill}>{parsed.bpm} BPM</span>
              <span style={st.pill}>{parsed.timeSig}</span>
              <span style={st.pill}>{parsed.tracks.length} track</span>
            </div>
            <div style={{ fontSize: 10, color: "#666", letterSpacing: 2, textTransform: "uppercase", margin: "12px 0 8px", fontFamily: "monospace" }}>Track → Partisyon</div>
            {parsed.tracks.map((tr, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
                <div style={{ flex: 1, fontSize: 12, color: "#EEE8D5", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {tr.name} <span style={{ color: "#666", fontSize: 10 }}>({tr.notes.length} nota{tr.channel === 9 ? " · davul" : ""})</span>
                </div>
                <select style={{ ...st.formInput, width: 112, marginTop: 0 }} value={assign[i] || ""} onChange={(e) => setAssign((p) => ({ ...p, [i]: e.target.value }))}>
                  <option value="">— atla —</option>
                  {PART_ORDER.map((k) => <option key={k} value={k}>{INSTRUMENTS[k].label}</option>)}
                </select>
              </div>
            ))}
            <button style={{ ...st.bigBtn, opacity: canCreate ? 1 : 0.4 }}
              onClick={() => canCreate && onCreate({ title: title.trim(), artist: artist.trim(), parsed, assign })}>
              Şarkıyı Oluştur
            </button>
          </>
        )}

        {stage === "error" && (
          <p style={{ color: "#C97E7E", fontSize: 12, textAlign: "center", margin: "18px 8px", lineHeight: 1.7 }}>{err}</p>
        )}

        <button style={st.sheetClose} onClick={onClose}>Kapat</button>
      </div>
    </div>
  );
}

// ─── ODAYA KATILMA ───────────────────────────────────────────────────────────
function RoomJoin({ onJoin, onClose }) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const join = async () => {
    if (!code.trim() || busy) return;
    setBusy(true);
    const e = await onJoin(code);
    setBusy(false);
    if (e) setErr(e);
  };
  return (
    <div style={st.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={st.sheet}>
        <div style={st.sheetHandle} />
        <div style={st.sheetTitle}>📡 Odaya Katıl</div>
        <p style={{ color: "#999", fontSize: 12, lineHeight: 1.7, textAlign: "center", margin: "14px 6px" }}>
          Host'un paylaştığı 5 haneli kodu girin. Şarkı ve çalma durumu
          otomatik senkronlanır — play, hız ve loop kontrolü host'tadır.
        </p>
        <input
          style={{ ...st.formInput, textAlign: "center", fontSize: 22, letterSpacing: 8, fontFamily: "monospace", textTransform: "uppercase" }}
          maxLength={5}
          placeholder="KOD"
          value={code}
          onChange={(e) => { setCode(e.target.value.toUpperCase()); setErr(""); }}
          onKeyDown={(e) => e.key === "Enter" && join()}
        />
        {err && <div style={{ color: "#C97E7E", fontSize: 12, textAlign: "center", marginTop: 8 }}>{err}</div>}
        <button style={{ ...st.bigBtn, opacity: code.trim().length === 5 && !busy ? 1 : 0.4 }} onClick={join}>
          {busy ? "Bağlanıyor…" : "Katıl"}
        </button>
        <button style={st.sheetClose} onClick={onClose}>Vazgeç</button>
      </div>
    </div>
  );
}

// ─── ŞARKI DETAY ─────────────────────────────────────────────────────────────
function SongDetail({ song, parts, onPickPart, onBack, onMetro, room, onCreateRoom, onCloseRoom }) {
  const [creating, setCreating] = useState(false);
  const isRoomSong = song.id === "room";
  const isHostHere = room?.role === "host" && room.songId === song.id;
  const canHost = !room && !isRoomSong && Object.values(song.parts).some((p) => p?.events?.length);
  return (
    <div style={{ ...st.col, overflowY: "auto" }}>
      <div style={st.hero}>
        <button style={st.back} onClick={onBack}>‹</button>
        <div style={st.heroTitle}>{song.title}</div>
        <div style={st.heroArtist}>{song.artist}</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
          <span style={st.pill}>{song.key}</span>
          <span style={st.pill}>{song.tempo} BPM</span>
          <span style={st.pill}>{song.time}</span>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button style={st.metroBtn} onClick={onMetro}>◉ Metronom · {song.tempo}</button>
          {canHost && (
            <button style={{ ...st.metroBtn, borderColor: "#7EC97E55", color: "#7EC97E", background: "#0f1a0f" }}
              disabled={creating}
              onClick={async () => { setCreating(true); await onCreateRoom(song); setCreating(false); }}>
              {creating ? "Oda açılıyor…" : "📡 Oda Aç"}
            </button>
          )}
          {isHostHere && (
            <button style={{ ...st.metroBtn, borderColor: "#C97E7E55", color: "#C97E7E", background: "#1a0f0f" }}
              onClick={onCloseRoom}>
              📡 Odayı Kapat
            </button>
          )}
        </div>
        {isHostHere && (
          <div style={{ marginTop: 12, padding: "10px 14px", background: "#0f1a0f", border: "1px solid #7EC97E44", borderRadius: 12 }}>
            <div style={{ fontSize: 10, color: "#7EC97E99", letterSpacing: 2, textTransform: "uppercase", fontFamily: "monospace" }}>Oda Kodu — grupla paylaş</div>
            <div style={{ fontSize: 28, color: "#7EC97E", fontFamily: "monospace", letterSpacing: 8, marginTop: 4 }}>{room.code}</div>
            <div style={{ fontSize: 10, color: "#666", marginTop: 4, lineHeight: 1.5 }}>
              Play/pause, hız, loop ve konum kontrolü sende. Not: oda verisi bu uygulamayı kullanan herkese görünür olabilir.
            </div>
          </div>
        )}
        {isRoomSong && (
          <div style={{ marginTop: 12, padding: "8px 12px", background: "#0f1a0f", border: "1px solid #7EC97E33", borderRadius: 10, fontSize: 11, color: "#7EC97E", fontFamily: "monospace" }}>
            📡 Odadasın — enstrümanını seç, host kontrol ediyor. Geri tuşu odadan çıkarır.
          </div>
        )}
      </div>
      <div style={st.sectionLabel}>Partisyonlar</div>
      <div style={{ padding: "0 14px", display: "flex", flexDirection: "column", gap: 8 }}>
        {parts.map((pk) => {
          const inst = INSTRUMENTS[pk];
          const has = song.parts[pk]?.content;
          return (
            <button key={pk} style={{ ...st.partCard, borderColor: inst.color + "33" }} onClick={() => onPickPart(pk)}>
              <span style={{ ...st.partIcon, background: inst.color + "22" }}>{inst.icon}</span>
              <span style={{ flex: 1, fontFamily: "Georgia, serif", fontSize: 15 }}>{inst.label}</span>
              {!has && <span style={st.waiting}>tab bekleniyor</span>}
              <span style={{ color: inst.color, fontSize: 20 }}>›</span>
            </button>
          );
        })}
      </div>
      <div style={{ padding: 18, color: "#555", fontSize: 11, lineHeight: 1.6 }}>
        Boş partisyonlara girip ✎ ile tab yapıştırın. ▶ ile tab akar, 🎙 ile pratik puanı alırsınız.
      </div>
    </div>
  );
}

// ─── PARTİSYON: GÖRÜNTÜLE / DÜZENLE / OYNAT ──────────────────────────────────
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function PartView({ song, part, allParts, fontSize, setFontSize, onChangePart, onBack, onMetro, onPractice, onSave, roomRole = null, roomCode = null, transport = null, onTransport = null }) {
  const inst = INSTRUMENTS[part];
  const data = song.parts[part];
  const hasContent = !!data?.content;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftNotes, setDraftNotes] = useState("");
  const [draftPractice, setDraftPractice] = useState("");
  const [pct, setPct] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const ref = useRef(null);
  const rafRef = useRef(null);
  const lastTs = useRef(0);
  // Ses modu: 0 = tüm sesler açık, 1 = sadece bu enstrüman kapalı, 2 = tüm sesler kapalı
  const [audioMode, setAudioMode] = useState(0);
  const [cursorTick, setCursorTick] = useState(0);
  const [loopBars, setLoopBars] = useState(0);
  const [loopStartTick, setLoopStartTick] = useState(0);
  const audioModeRef = useRef(0);
  const loopRef = useRef({ bars: 0, start: 0 });
  const seekVer = useRef(0);
  useEffect(() => { audioModeRef.current = audioMode; }, [audioMode]);
  useEffect(() => { loopRef.current = { bars: loopBars, start: loopStartTick }; }, [loopBars, loopStartTick]);
  const audioCtxRef = useRef(null);
  const tickRef = useRef(0);
  const lastCurUpd = useRef(0);
  const hasAudioSong = Object.values(song.parts).some((p) => p?.events?.length);
  const isStaffPart = data?.events && (part === "bassist" || part === "gitarist" || part === "baterist");

  // ─── PRATİK MODU (Guitar Hero tarzı) ───
  const [practiceOn, setPracticeOn] = useState(false);
  const [countIn, setCountIn] = useState(0);          // 4,3,2,1,0 (0 = akış başladı)
  const [liveNote, setLiveNote] = useState("—");
  const [pScore, setPScore] = useState({ hit: 0, miss: 0, combo: 0, maxCombo: 0, total: 0 });
  const [pFlash, setPFlash] = useState(null);         // "hit" | "miss" son geri bildirim
  const [pResult, setPResult] = useState(null);
  const practiceRef = useRef(false);
  const micStreamRef = useRef(null);
  const micRafRef = useRef(null);
  const analyserRef = useRef(null);
  const targetsRef = useRef([]);      // {s, m, pc, hit, judged}
  const scoreRef = useRef({ hit: 0, miss: 0, combo: 0, maxCombo: 0, total: 0 });
  const lastPlayedPcRef = useRef(-1);
  const lastPlayedAtRef = useRef(0);
  useEffect(() => { practiceRef.current = practiceOn; }, [practiceOn]);
  // Solist için de tick tabanlı sync mümkün: şarkı MIDI'den geldiyse ticksPerBar'ı biliriz
  const anyMidiPart = Object.values(song.parts).find((p) => p?.ticksPerBar);
  const beatsPerBarSong = parseInt(song.time.split("/")[0], 10) || 4;
  const songTicksPerBar = anyMidiPart?.ticksPerBar || 480 * beatsPerBarSong;
  const canSeekLoop = isStaffPart || (part === "solist" && hasAudioSong);
  const solistSync = part === "solist" && hasAudioSong;

  // ─── Pratik: mikrofon + isabet tespiti ───
  const stopPractice = useCallback((showResult = false) => {
    practiceRef.current = false;
    setPracticeOn(false);
    setCountIn(0);
    cancelAnimationFrame(micRafRef.current);
    if (micStreamRef.current) { micStreamRef.current.getTracks().forEach((t) => t.stop()); micStreamRef.current = null; }
    if (showResult) {
      const s = scoreRef.current;
      const acc = s.total > 0 ? Math.round((s.hit / s.total) * 100) : 0;
      const stars = Math.max(0, Math.min(5, Math.round(acc / 20)));
      setPResult({ ...s, acc, stars });
    }
    setPlaying(false);
  }, []);

  const startPractice = useCallback(async () => {
    if (!isStaffPart) return; // nota verisi gerektirir
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!audioCtxRef.current) audioCtxRef.current = new AC();
      await audioCtxRef.current.resume();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      micStreamRef.current = stream;
      const srcNode = audioCtxRef.current.createMediaStreamSource(stream);
      const analyser = audioCtxRef.current.createAnalyser();
      analyser.fftSize = 2048;
      srcNode.connect(analyser);
      analyserRef.current = analyser;

      // Hedef notaları hazırla (bu partisyonun tüm event'leri)
      targetsRef.current = (data.events || []).map((e) => ({
        s: e.s, m: e.m, pc: ((e.m % 12) + 12) % 12, judged: false, hit: false,
      }));
      scoreRef.current = { hit: 0, miss: 0, combo: 0, maxCombo: 0, total: targetsRef.current.length };
      setPScore({ ...scoreRef.current });
      setPResult(null);
      setPFlash(null);
      lastPlayedPcRef.current = -1;

      // Baştan başlat
      tickRef.current = 0;
      setCursorTick(0);
      if (ref.current) ref.current.scrollTop = 0;

      setPracticeOn(true);
      practiceRef.current = true;

      // 4→1 geri sayım (şarkı temposunda), sonra akış
      const interval = 60000 / song.tempo;
      let c = beatsPerBarSong;
      setCountIn(c);
      // sayım tık sesi
      const tick = () => {
        playClick(audioCtxRef.current, c === beatsPerBarSong, "bip", 0.4);
        c--;
        setCountIn(c);
        if (c <= 0) {
          clearInterval(ci);
          setCountIn(0);
          setPlaying(true);       // ana akış motoru başlar (aşağıdaki useEffect)
          startMicLoop();
        }
      };
      const ci = setInterval(tick, interval);
      tick();
    } catch {
      setPracticeOn(false);
      setPResult({ error: true });
    }
  }, [isStaffPart, data, song.tempo, beatsPerBarSong]);

  const startMicLoop = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const buf = new Float32Array(analyser.fftSize);
    const sr = audioCtxRef.current.sampleRate;
    const loop = () => {
      if (!practiceRef.current) return;
      analyser.getFloatTimeDomainData(buf);
      const { freq } = autoCorrelate(buf, sr);
      if (freq > 0) {
        const pc = ((freqToMidi(freq) % 12) + 12) % 12;
        setLiveNote(freqToNote(freq));
        const now = performance.now();
        // Aynı notayı tekrar tekrar saymamak için: farklı pc ya da 120ms boşluk
        if (pc !== lastPlayedPcRef.current || now - lastPlayedAtRef.current > 140) {
          lastPlayedPcRef.current = pc;
          lastPlayedAtRef.current = now;
          judgePlay(pc);
        }
      } else {
        setLiveNote("—");
      }
      micRafRef.current = requestAnimationFrame(loop);
    };
    micRafRef.current = requestAnimationFrame(loop);
  }, []);

  // Çalınan pc'yi cursor civarındaki hedefle karşılaştır
  const judgePlay = useCallback((pc) => {
    const division = data.division || 480;
    const nowTick = tickRef.current;
    const windowTicks = division * 0.6; // ±yarım vuruşa yakın tolerans
    const targets = targetsRef.current;
    // Cursor'a en yakın, henüz yargılanmamış, pc eşleşen hedef
    let bestIdx = -1, bestDist = Infinity;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (t.judged) continue;
      const dist = Math.abs(t.s - nowTick);
      if (dist > windowTicks) continue;
      if (t.pc === pc && dist < bestDist) { bestDist = dist; bestIdx = i; }
    }
    const s = scoreRef.current;
    if (bestIdx >= 0) {
      targets[bestIdx].judged = true;
      targets[bestIdx].hit = true;
      s.hit++; s.combo++; s.maxCombo = Math.max(s.maxCombo, s.combo);
      setPFlash("hit");
      setPScore({ ...s });
    } else {
      // Yanlış nota → combo sıfırla (miss say ama total'ı şişirme)
      s.combo = 0;
      setPFlash("miss");
      setPScore({ ...s });
    }
    setTimeout(() => setPFlash(null), 150);
  }, [data]);

  // Cursor bir hedefi tolerans penceresinin ötesine geçtiyse ve çalınmadıysa → kaçırıldı
  useEffect(() => {
    if (!practiceOn || countIn > 0) return;
    const division = data?.division || 480;
    const past = tickRef.current - division * 0.6;
    let changed = false;
    const s = scoreRef.current;
    for (const t of targetsRef.current) {
      if (!t.judged && t.s < past) {
        t.judged = true; t.hit = false;
        s.miss++; s.combo = 0; changed = true;
      }
    }
    if (changed) setPScore({ ...s });
    // Şarkı bitti mi?
    const allJudged = targetsRef.current.length > 0 && targetsRef.current.every((t) => t.judged);
    if (allJudged) stopPractice(true);
  }, [cursorTick, practiceOn, countIn, data, stopPractice]);

  const seekTo = useCallback((tick) => {
    const clamped = Math.max(0, tick);
    tickRef.current = clamped;
    setCursorTick(clamped);
    seekVer.current++;
    if (ref.current) {
      if (isStaffPart) {
        const rowH = staffRowHeight(part === "bassist" ? 4 : 6);
        const rowIdx = Math.floor(clamped / ((data.ticksPerBar || 1) * BARS_PER_ROW));
        ref.current.scrollTop = Math.max(0, rowIdx * rowH - ref.current.clientHeight * 0.28);
      } else if (solistSync) {
        const lineH = fontSize * 1.75;
        ref.current.scrollTop = (clamped / songTicksPerBar) * lineH;
      }
    }
  }, [isStaffPart, solistSync, part, data, fontSize, songTicksPerBar]);

  const cycleLoop = useCallback(() => {
    if (!canSeekLoop) return;
    const tpb = data?.ticksPerBar || songTicksPerBar;
    setLoopBars((prev) => {
      if (prev >= 4) { setLoopStartTick(0); return 0; }
      if (prev === 0) {
        // Cursor'un içinde bulunduğu barı loop başlangıcı yap
        const bar = Math.floor(tickRef.current / tpb) * tpb;
        setLoopStartTick(bar);
      }
      return prev + 1;
    });
  }, [canSeekLoop, data, songTicksPerBar]);

  useEffect(() => {
    setEditing(false); setPct(0); setPlaying(false);
    tickRef.current = 0;
    setCursorTick(0);
    if (ref.current) ref.current.scrollTop = 0;
  }, [part, song.id]);

  // HOST: kontrol değişince transport durumunu odaya yaz (herkes kendi pozisyonunu hesaplar)
  useEffect(() => {
    if (roomRole !== "host" || !onTransport) return;
    onTransport({
      playing,
      startTick: tickRef.current,
      epoch: Date.now(),
      speed,
      loopStart: loopStartTick,
      loopBars,
    });
  }, [roomRole, playing, speed, loopBars, loopStartTick, cursorTick, onTransport]);

  // ÜYE: gelen transport'u uygula — pozisyonu epoch'tan bugüne uzatarak hesapla
  useEffect(() => {
    if (roomRole !== "member" || !transport) return;
    const beatsPerBar = parseInt(song.time.split("/")[0], 10) || 4;
    const anyMidi = Object.values(song.parts).find((p) => p?.division);
    const division = anyMidi?.division || 480;
    const tps = (division * song.tempo * (transport.speed || 1)) / 60;
    // Loop'u yansıt
    if ((transport.loopBars || 0) !== loopBars) setLoopBars(transport.loopBars || 0);
    if ((transport.loopStart || 0) !== loopStartTick) setLoopStartTick(transport.loopStart || 0);
    if ((transport.speed || 1) !== speed) setSpeed(transport.speed || 1);

    if (transport.playing) {
      // Host çalıyorsa: geçen süreyi ekleyip yerel motoru başlat
      const elapsed = (Date.now() - transport.epoch) / 1000;
      let pos = transport.startTick + elapsed * tps;
      const tpb = anyMidi?.ticksPerBar || division * beatsPerBar;
      if (transport.loopBars > 0) {
        const ls = transport.loopStart, le = ls + transport.loopBars * tpb;
        if (pos >= le) pos = ls + ((pos - ls) % (le - ls));
      }
      tickRef.current = pos;
      seekVer.current++;
      if (!playing) setPlaying(true);
    } else {
      // Host durdurduysa: yerel motoru durdur, cursor'u host'un konumuna koy
      if (playing) setPlaying(false);
      tickRef.current = transport.startTick;
      setCursorTick(transport.startTick);
      seekVer.current++;
    }
  }, [roomRole, transport, song]);

  // Çalma motoru: tik tabanlı saat → ses zamanlaması + imleç + kaydırma
  useEffect(() => {
    if (!playing) { cancelAnimationFrame(rafRef.current); return; }
    lastTs.current = 0;
    const beatsPerBar = parseInt(song.time.split("/")[0], 10) || 4;
    const staffMode = !!isStaffPart;
    const rowH = staffRowHeight(part === "bassist" ? 4 : 6);
    const lineH = fontSize * 1.75;

    // MIDI olaylarını birleştir (tüm partisyonlar — mix için)
    const midiParts = Object.entries(song.parts).filter(([, v]) => v?.events?.length);
    const hasAudio = midiParts.length > 0;
    let merged = [], division = 480, ticksPerBar = 1920, maxTick = 0;
    if (hasAudio) {
      division = midiParts[0][1].division || 480;
      ticksPerBar = midiParts[0][1].ticksPerBar || division * beatsPerBar;
      for (const [k, v] of midiParts) for (const e of v.events) merged.push({ s: e.s, d: e.d, m: e.m, k });
      merged.sort((a, b) => a.s - b.s);
      maxTick = merged.reduce((mx, e) => Math.max(mx, e.s + e.d), 0);
    }
    const ticksPerSec = (division * song.tempo * speed) / 60;

    let ctx = null;
    if (hasAudio) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!audioCtxRef.current) audioCtxRef.current = new AC();
      ctx = audioCtxRef.current;
      ctx.resume();
    }

    // Loop aktifse ve cursor loop bölgesi dışındaysa başa al
    const lp = loopRef.current;
    if (lp.bars > 0) {
      const lpEnd = lp.start + lp.bars * ticksPerBar;
      if (tickRef.current < lp.start || tickRef.current >= lpEnd) {
        tickRef.current = lp.start;
        setCursorTick(lp.start);
      }
    }

    let nextIdx = merged.findIndex((e) => e.s >= tickRef.current);
    if (nextIdx < 0) nextIdx = merged.length;
    let localSeekVer = seekVer.current;

    const pxPerSecText = data?.synced
      ? ((lineH * song.tempo) / (60 * beatsPerBar)) * speed
      : (song.tempo / 60) * fontSize * 0.55 * speed;

    const step = (ts) => {
      if (!lastTs.current) lastTs.current = ts;
      const dt = (ts - lastTs.current) / 1000;
      lastTs.current = ts;
      tickRef.current += dt * ticksPerSec;

      // Loop: bitişi geçtiysek başa sar
      const lpNow = loopRef.current;
      if (lpNow.bars > 0) {
        const lpEnd = lpNow.start + lpNow.bars * ticksPerBar;
        if (tickRef.current >= lpEnd) {
          tickRef.current = lpNow.start + (tickRef.current - lpEnd);
          nextIdx = merged.findIndex((e) => e.s >= tickRef.current);
          if (nextIdx < 0) nextIdx = merged.length;
        }
      }

      // Dışarıdan seek olduysa event pointer'ı tazele
      if (seekVer.current !== localSeekVer) {
        localSeekVer = seekVer.current;
        nextIdx = merged.findIndex((e) => e.s >= tickRef.current);
        if (nextIdx < 0) nextIdx = merged.length;
      }

      // Ses: yaklaşan notaları planla (seçili partisyon baskın, kendi partını susturma seçeneği)
      if (ctx) {
        const horizon = tickRef.current + ticksPerSec * 0.2;
        while (nextIdx < merged.length && merged[nextIdx].s <= horizon) {
          const e = merged[nextIdx++];
          const when = ctx.currentTime + Math.max(0, (e.s - tickRef.current) / ticksPerSec);
          const isCur = e.k === part;
          const mode = audioModeRef.current;
          let vol;
          if (practiceRef.current) {
            // Pratik modu: çalınan enstrümanın sesi verilmez (kullanıcı çalar), diğerleri eşlik eder
            vol = isCur ? 0 : 0.32;
          } else if (mode === 2) vol = 0;
          else if (isCur) vol = mode === 1 ? 0 : 1;
          else vol = 0.3;
          if (vol > 0) synthNote(ctx, e.k, e.m, when, e.d / ticksPerSec, vol);
        }
      }

      const el = ref.current;
      if (el) {
        if (staffMode) {
          const rowIdx = Math.floor(tickRef.current / (ticksPerBar * BARS_PER_ROW));
          el.scrollTop = Math.max(0, rowIdx * rowH - el.clientHeight * 0.28);
        } else if (data?.synced && hasAudio) {
          // Metin tabanlı senkron: her satır bir bar → scroll doğrudan tik'ten türetilir
          el.scrollTop = (tickRef.current / ticksPerBar) * lineH;
        } else {
          el.scrollTop += pxPerSecText * dt;
        }
        const max = el.scrollHeight - el.clientHeight;
        setPct(Math.min(1, el.scrollTop / Math.max(1, max)));
        if (!hasAudio && el.scrollTop >= max - 1) { setPlaying(false); return; }
      }

      // İmleç (saniyede ~25 güncelleme)
      if (ts - lastCurUpd.current > 40) {
        lastCurUpd.current = ts;
        setCursorTick(tickRef.current);
      }

      if (hasAudio && loopRef.current.bars === 0 && tickRef.current > maxTick + division * 2) {
        tickRef.current = 0;
        setCursorTick(0);
        setPlaying(false);
        return;
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, speed, fontSize, song.tempo, song.time, song.parts, data, part, isStaffPart]);

  const startEdit = () => {
    setPlaying(false);
    setDraft(hasContent ? data.content : "");
    setDraftNotes(data?.notes || "");
    setDraftPractice(data?.practiceNotes || "");
    setEditing(true);
  };
  const save = () => { onSave(song.id, part, draft, draftNotes, draftPractice); setEditing(false); };

  return (
    <div style={st.col}>
      <div style={{ ...st.partHeader, borderBottomColor: inst.color + "33" }}>
        <button style={st.back} onClick={onBack}>‹</button>
        <div style={{ flex: 1, textAlign: "center" }}>
          <div style={{ fontSize: 13, fontFamily: "Georgia, serif" }}>{song.title}</div>
          <div style={{ fontSize: 11, color: inst.color, fontFamily: "monospace" }}>{inst.icon} {inst.label}</div>
        </div>
        <div style={{ display: "flex", gap: 5 }}>
          <button style={{ ...st.iconBtn, color: inst.color }} onClick={editing ? save : startEdit}>{editing ? "✓" : "✎"}</button>
        </div>
      </div>

      <div style={st.tabs}>
        {allParts.map((p) => (
          <button key={p} onClick={() => onChangePart(p)}
            style={{ ...st.tab, borderBottomColor: p === part ? INSTRUMENTS[p].color : "transparent", opacity: p === part ? 1 : 0.5 }}>
            {INSTRUMENTS[p].icon}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button
          title={isStaffPart ? "Pratik modu (Guitar Hero)" : "Pratik modu MIDI nota verisi gerektirir"}
          style={{ ...st.tab, opacity: isStaffPart ? 1 : 0.35, color: practiceOn ? "#7EC97E" : "inherit" }}
          onClick={() => { if (!isStaffPart) return; practiceOn ? stopPractice(false) : startPractice(); }}>
          🎮
        </button>
        <button style={{ ...st.tab, color: "#E8C97E", opacity: 1 }} onClick={onMetro}>◉</button>
      </div>

      {editing ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: 12, gap: 8 }}>
          <div style={{ fontSize: 11, color: "#888", lineHeight: 1.5 }}>
            Lisanslı kaynaktan kopyaladığınız tab/söz metnini yapıştırın:
          </div>
          <textarea style={st.editor} value={draft} onChange={(e) => setDraft(e.target.value)}
            placeholder={part === "solist"
              ? "Sözleri buraya yazın. Bar numaraları için başlarına [  1], [  2] ekleyebilirsiniz — örn:\n[  1]  Gökyüzünde süzülür\n[  2]  Rüzgarla dans eder"
              : `${inst.label} için tab veya notaları buraya yapıştır…`} />
          <input style={st.notesInput} value={draftNotes} onChange={(e) => setDraftNotes(e.target.value)}
            placeholder="Not (ton, ekipman, ipucu)" />
          <input style={st.notesInput} value={draftPractice} onChange={(e) => setDraftPractice(e.target.value)}
            placeholder="Pratik notaları — ör: La2 La2 Do3 La2 Sol2 Mi2 (isteğe bağlı)" />
          <div style={{ display: "flex", gap: 8 }}>
            <button style={st.saveBtn} onClick={save}>Kaydet</button>
            <button style={st.cancelBtn} onClick={() => setEditing(false)}>Vazgeç</button>
          </div>
        </div>
      ) : hasContent ? (
        <>
          {data.notes && (
            <div style={{ ...st.noteBanner, borderLeftColor: inst.color }}>
              <b style={{ color: inst.color, fontSize: 10 }}>NOT › </b>
              <span style={{ color: "#999", fontSize: 11 }}>{data.notes}</span>
            </div>
          )}
          <div style={st.progressTrack}>
            <div style={{ ...st.progressBar, width: `${pct * 100}%`, background: inst.color }} />
          </div>
          <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
            {solistSync && (
              <>
                <div style={{ position: "absolute", left: 0, right: 0, top: 170, height: 2, background: `linear-gradient(90deg, transparent, ${inst.color}, transparent)`, boxShadow: `0 0 12px ${inst.color}99`, pointerEvents: "none", zIndex: 5, opacity: playing ? 1 : 0.55 }} />
                {playing && <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: 170, background: "linear-gradient(180deg, rgba(10,10,15,.55), transparent)", pointerEvents: "none", zIndex: 4 }} />}
              </>
            )}
            <div ref={ref} style={{
                height: "100%", overflowY: "auto",
                padding: solistSync ? "170px 16px 14px" : "14px 16px",
                fontSize, boxSizing: "border-box"
              }}
              onScroll={() => {
                const el = ref.current;
                if (el) setPct(Math.min(1, el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight)));
              }}>
              {data.events && (part === "bassist" || part === "gitarist" || part === "baterist") ? (
                <Staff events={data.events} ticksPerBar={data.ticksPerBar} division={data.division}
                  labels={part === "baterist" ? DRUM_LINES.map((d) => d.label) : TUNINGS[part].labels}
                  place={part === "baterist" ? drumPlacer : stringPlacer(TUNINGS[part].open)}
                  color={inst.color} cursorTick={cursorTick}
                  onSeek={seekTo}
                  loop={loopBars > 0 ? { bars: loopBars, start: loopStartTick } : null} />
              ) : solistSync ? (
                <div style={{ position: "relative" }}>
                  {loopBars > 0 && (
                    <div style={{
                      position: "absolute",
                      top: (loopStartTick / songTicksPerBar) * (fontSize * 1.75),
                      height: loopBars * (fontSize * 1.75),
                      left: -8, right: -8,
                      background: "#7EC97E14",
                      border: "1px dashed #7EC97E88",
                      borderRadius: 4,
                      pointerEvents: "none",
                    }} />
                  )}
                  <pre style={{ ...st.pre, cursor: "pointer", position: "relative", zIndex: 1 }}
                    onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const y = e.clientY - rect.top;
                      const line = Math.max(0, Math.floor(y / (fontSize * 1.75)));
                      seekTo(line * songTicksPerBar);
                    }}>{data.content}</pre>
                </div>
              ) : (
                <pre style={st.pre}>{data.content}</pre>
              )}
              <div style={{ height: 80 }} />
            </div>
            {/* Pratik: geri sayım örtüsü */}
            {practiceOn && countIn > 0 && (
              <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "rgba(7,7,12,.75)", zIndex: 10 }}>
                <div className="count-pop" key={countIn} style={{ fontSize: 110, fontFamily: "Georgia, serif", color: "#7EC97E", lineHeight: 1, textShadow: "0 0 40px rgba(126,201,126,.6)" }}>{countIn}</div>
                <div style={{ fontSize: 12, color: "#888", letterSpacing: 4, textTransform: "uppercase", marginTop: 8 }}>Hazır ol — çalmaya başla</div>
              </div>
            )}
            {/* Pratik: isabet flaşı (kenar parıltısı) */}
            {practiceOn && pFlash && (
              <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 9,
                boxShadow: `inset 0 0 60px ${pFlash === "hit" ? "rgba(126,201,126,.45)" : "rgba(201,126,126,.4)"}`,
                transition: "opacity .1s" }} />
            )}
          </div>

          {/* Pratik skor paneli */}
          {practiceOn && (
            <div style={st.practicePanel}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ textAlign: "center", minWidth: 54 }}>
                  <div style={{ fontSize: 22, fontFamily: "Georgia, serif", color: pFlash === "hit" ? "#7EC97E" : pFlash === "miss" ? "#C97E7E" : "#EEE8D5", transition: "color .1s" }}>{liveNote}</div>
                  <div style={{ fontSize: 8, color: "#666", letterSpacing: 1, textTransform: "uppercase" }}>çaldığın</div>
                </div>
                <div style={{ flex: 1, display: "flex", gap: 14, justifyContent: "center" }}>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 18, color: "#7EC97E", fontFamily: "monospace" }}>{pScore.hit}</div>
                    <div style={{ fontSize: 8, color: "#666", textTransform: "uppercase" }}>isabet</div>
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 18, color: "#C97E7E", fontFamily: "monospace" }}>{pScore.miss}</div>
                    <div style={{ fontSize: 8, color: "#666", textTransform: "uppercase" }}>kaçan</div>
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 18, color: "#E8C97E", fontFamily: "monospace" }}>{pScore.combo}<span style={{ fontSize: 11 }}>×</span></div>
                    <div style={{ fontSize: 8, color: "#666", textTransform: "uppercase" }}>kombo</div>
                  </div>
                </div>
                <button style={{ ...st.playCtl, width: 40, height: 40, fontSize: 12, borderColor: "#C97E7E66", color: "#C97E7E", background: "#2a1515" }}
                  onClick={() => stopPractice(true)}>■</button>
              </div>
              <div style={{ height: 4, background: "#1a1a24", borderRadius: 2, marginTop: 8, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${pScore.total ? (pScore.hit + pScore.miss) / pScore.total * 100 : 0}%`, background: "linear-gradient(90deg,#7EC97E,#E8C97E)", transition: "width .2s" }} />
              </div>
            </div>
          )}
          {/* Oynatma çubuğu (pratik modunda gizli — kendi kontrolü var) */}
          {!practiceOn && (
          <div style={{ ...st.playBar, borderTopColor: inst.color + "22" }}>
            {roomRole === "member" ? (
              <span title="Kontrol host'ta" style={{ ...st.playCtl, borderColor: "#ffffff18", color: "#555", display: "flex", alignItems: "center", justifyContent: "center", cursor: "default" }}>
                {playing ? "❚❚" : "▶"}
              </span>
            ) : (
              <button style={{ ...st.playCtl, borderColor: inst.color + "66", color: inst.color }}
                onClick={() => setPlaying((p) => !p)}>
                {playing ? "❚❚" : "▶"}
              </button>
            )}
            {roomRole !== "member" && (
              <button style={{ ...st.playCtl, width: 34, height: 34, fontSize: 12, borderColor: "#ffffff22", color: "#888" }}
                onClick={() => {
                  tickRef.current = 0;
                  setCursorTick(0);
                  if (ref.current) ref.current.scrollTop = 0;
                }}>
                ⏮
              </button>
            )}
            {hasAudioSong && (() => {
              const cfg = [
                { icon: "🔊", label: "Tüm sesler açık", bc: inst.color + "44", c: inst.color, bg: "#17130a" },
                { icon: "🔉", label: "Bu enstrüman kapalı", bc: "#E8C97E66", c: "#E8C97E", bg: "#1a1608" },
                { icon: "🔇", label: "Tüm sesler kapalı", bc: "#C97E7E66", c: "#C97E7E", bg: "#2a1515" },
              ][audioMode];
              return (
                <button
                  title={`Ses: ${cfg.label} (değiştirmek için dokun)`}
                  style={{ ...st.playCtl, width: 34, height: 34, fontSize: 13, borderColor: cfg.bc, color: cfg.c, background: cfg.bg }}
                  onClick={() => setAudioMode((m) => (m + 1) % 3)}>
                  {cfg.icon}
                </button>
              );
            })()}
            {canSeekLoop && roomRole !== "member" && (
              <button
                title="Loop: cursor'ın bulunduğu bardan başlayarak 1→2→3→4 bar, sonra kapalı"
                style={{ ...st.playCtl, width: 40, height: 34, fontSize: 11, fontFamily: "monospace",
                  borderColor: loopBars > 0 ? "#7EC97E88" : "#ffffff22",
                  color: loopBars > 0 ? "#7EC97E" : "#666",
                  background: loopBars > 0 ? "#152a15" : "transparent" }}
                onClick={cycleLoop}>
                {loopBars > 0 ? `⟲${loopBars}` : "⟲"}
              </button>
            )}
            <div style={{ display: "flex", gap: 4, flex: 1, justifyContent: "center" }}>
              {roomRole === "member" ? (
                <span style={{ fontSize: 10, color: "#7EC97E", fontFamily: "monospace" }}>📡 {roomCode} · host kontrol ediyor</span>
              ) : SPEEDS.map((s) => (
                <button key={s} onClick={() => setSpeed(s)}
                  style={{ ...st.speedChip, background: speed === s ? inst.color + "26" : "transparent", color: speed === s ? inst.color : "#666", borderColor: speed === s ? inst.color + "55" : "#ffffff12" }}>
                  {s}×
                </button>
              ))}
            </div>
            <span style={{ fontSize: 10, color: "#666", fontFamily: "monospace" }}>{song.tempo * speed | 0} BPM</span>
          </div>
          )}

          {/* Pratik sonuç ekranı */}
          {pResult && (
            <div style={{ position: "absolute", inset: 0, background: "rgba(7,7,12,.92)", zIndex: 20, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
              {pResult.error ? (
                <div style={{ color: "#C97E7E", textAlign: "center", fontSize: 13, lineHeight: 1.7 }}>
                  Mikrofona erişilemedi.<br />Tarayıcı izinlerini kontrol edin.
                </div>
              ) : (
                <>
                  <div style={{ fontSize: 34, letterSpacing: 4 }}>
                    {[0, 1, 2, 3, 4].map((i) => (
                      <span key={i} style={{ color: i < pResult.stars ? "#E8C97E" : "#2a2a35", textShadow: i < pResult.stars ? "0 0 14px rgba(232,201,126,.6)" : "none" }}>★</span>
                    ))}
                  </div>
                  <div style={{ fontSize: 46, fontFamily: "Georgia, serif", color: "#EEE8D5", marginTop: 10 }}>%{pResult.acc}</div>
                  <div style={{ fontSize: 10, color: "#666", letterSpacing: 2, textTransform: "uppercase" }}>İsabet Oranı</div>
                  <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
                    <div style={st.resultCell}><b style={{ color: "#7EC97E" }}>{pResult.hit}</b><span>isabet</span></div>
                    <div style={st.resultCell}><b style={{ color: "#C97E7E" }}>{pResult.miss}</b><span>kaçan</span></div>
                    <div style={st.resultCell}><b style={{ color: "#E8C97E" }}>{pResult.maxCombo}×</b><span>en yüksek kombo</span></div>
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 22, width: "100%", maxWidth: 300 }}>
                    <button style={{ ...st.saveBtn, background: "#152a15", borderColor: "#7EC97E55", color: "#7EC97E" }} onClick={() => { setPResult(null); startPractice(); }}>↻ Tekrar</button>
                    <button style={st.cancelBtn} onClick={() => setPResult(null)}>Kapat</button>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      ) : (
        <div style={st.emptyPart}>
          <div style={{ fontSize: 34, opacity: 0.5 }}>{inst.icon}</div>
          <div style={{ color: "#888", fontSize: 13, textAlign: "center", lineHeight: 1.7, maxWidth: 240 }}>
            Bu partisyon henüz boş.<br />Tab metnini elle girin veya lisanslı kaynaktan kopyalayıp yapıştırın.
          </div>
          <button style={{ ...st.saveBtn, borderColor: inst.color + "66", color: inst.color }} onClick={startEdit}>
            ✎ Tab Ekle
          </button>
        </div>
      )}
    </div>
  );
}

// ─── TAB / NOTA GÖRÜNÜMÜ (SVG) ───────────────────────────────────────────────
const BARS_PER_ROW = 2;
const STAFF_W = 380;   // telefon genişliğine yakın → orantılı ölçekte punto korunur
const GAP = 22;        // tel aralığı — telefonda okunur
const TOP = 26;        // üst boşluk
const FRET_FS = 15;    // perde numarası punto
const TUNINGS = {
  bassist: { labels: ["G", "D", "A", "E"], open: [43, 38, 33, 28] },
  gitarist: { labels: ["e", "B", "G", "D", "A", "E"], open: [64, 59, 55, 50, 45, 40] },
};
const DRUM_LINES = [
  { label: "Cr", set: [49, 52, 55, 57], sym: "x" },
  { label: "Rd", set: [51, 53, 59], sym: "x" },
  { label: "HH", set: [42, 44, 46], sym: "x" },
  { label: "SN", set: [37, 38, 39, 40], sym: "o" },
  { label: "Tm", set: [41, 43, 45, 47, 48, 50], sym: "o" },
  { label: "BD", set: [35, 36], sym: "o" },
];
function stringPlacer(open) {
  return (m) => {
    let best = null;
    for (let i = 0; i < open.length; i++) {
      const fret = m - open[i];
      if (fret >= 0 && fret <= 19 && (best === null || fret < best.fret)) best = { idx: i, fret };
    }
    if (!best) {
      const i = m < open[open.length - 1] ? open.length - 1 : 0;
      best = { idx: i, fret: Math.max(0, m - open[i]) };
    }
    return { idx: best.idx, text: best.fret };
  };
}
function drumPlacer(m) {
  for (let i = 0; i < DRUM_LINES.length; i++) {
    if (DRUM_LINES[i].set.includes(m)) return { idx: i, text: DRUM_LINES[i].sym };
  }
  return { idx: 4, text: "o" };
}
function staffRowHeight(nLines) {
  return TOP + (nLines - 1) * GAP + 44;
}

function Staff({ events, ticksPerBar, division, labels, place, color, cursorTick = null, onSeek = null, loop = null }) {
  const n = labels.length;
  const gap = GAP, top = TOP;
  const rowH = staffRowHeight(n);
  const X0 = 28;
  const barW = (STAFF_W - X0) / BARS_PER_ROW;
  const eighth = division / 2;
  const maxTick = events.reduce((m, e) => Math.max(m, e.s + e.d), 0);
  const totalBars = Math.max(1, Math.ceil(maxTick / ticksPerBar));
  const rows = Math.ceil(totalBars / BARS_PER_ROW);

  // Barlara dağıt; bar sınırını aşan notaya sonraki barda bağlı (tie) hayalet ekle
  const byBar = Array.from({ length: totalBars + 1 }, () => []);
  for (const e of events) {
    const b = Math.floor(e.s / ticksPerBar);
    if (byBar[b]) byBar[b].push(e);
    const endBar = Math.floor((e.s + e.d - 1) / ticksPerBar);
    if (endBar > b && byBar[b + 1]) byBar[b + 1].push({ ...e, ghost: true, s: (b + 1) * ticksPerBar, d: 0 });
  }

  return (
    <div>
      {Array.from({ length: rows }).map((_, r) => (
        <svg key={r} width="100%" height={rowH} viewBox={`0 0 ${STAFF_W} ${rowH}`} preserveAspectRatio="xMidYMid meet"
          onClick={onSeek ? (e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            // Orantılı ölçekte içerik yatayda ortalanır; viewBox koordinatına çevir
            const scale = rect.height / rowH;
            const drawnW = STAFF_W * scale;
            const offX = (rect.width - drawnW) / 2;
            const relX = ((e.clientX - rect.left - offX) / drawnW) * STAFF_W;
            if (relX < X0) return;
            const barsInRow = ((relX - X0) / (STAFF_W - X0)) * BARS_PER_ROW;
            onSeek(Math.max(0, (r * BARS_PER_ROW + barsInRow) * ticksPerBar));
          } : undefined}
          style={{ display: "block", cursor: onSeek ? "pointer" : "default" }}>
          {loop && loop.bars > 0 && (() => {
            const rowStart = r * BARS_PER_ROW * ticksPerBar;
            const rowEnd = rowStart + BARS_PER_ROW * ticksPerBar;
            const lStart = loop.start, lEnd = loop.start + loop.bars * ticksPerBar;
            if (lStart >= rowEnd || lEnd <= rowStart) return null;
            const a = Math.max(lStart, rowStart), b = Math.min(lEnd, rowEnd);
            const x1 = X0 + ((a - rowStart) / (rowEnd - rowStart)) * (STAFF_W - X0);
            const x2 = X0 + ((b - rowStart) / (rowEnd - rowStart)) * (STAFF_W - X0);
            return (
              <g>
                <rect x={x1} y={top - 14} width={x2 - x1} height={(n - 1) * gap + 34}
                  fill="#7EC97E" opacity="0.10" />
                <line x1={x1} y1={top - 14} x2={x1} y2={top + (n - 1) * gap + 20}
                  stroke="#7EC97E" strokeWidth="1.4" strokeDasharray="3 3" opacity="0.7" />
                <line x1={x2} y1={top - 14} x2={x2} y2={top + (n - 1) * gap + 20}
                  stroke="#7EC97E" strokeWidth="1.4" strokeDasharray="3 3" opacity="0.7" />
              </g>
            );
          })()}
          {labels.map((lb, i) => {
            const y = top + i * gap;
            return (
              <g key={i}>
                <line x1={X0} y1={y} x2={STAFF_W} y2={y} stroke="#33333e" strokeWidth="1" />
                <text x={4} y={y + 4.5} fontSize="13" fill="#6a6a76" fontFamily="monospace" fontWeight="600">{lb}</text>
              </g>
            );
          })}
          {Array.from({ length: BARS_PER_ROW + 1 }).map((_, bi) => (
            <line key={`bl${bi}`} x1={X0 + bi * barW} y1={top} x2={X0 + bi * barW} y2={top + (n - 1) * gap} stroke="#484855" strokeWidth={bi === 0 ? 1.6 : 1} />
          ))}
          {cursorTick != null && (() => {
            const rowStart = r * BARS_PER_ROW * ticksPerBar;
            const rowEnd = rowStart + BARS_PER_ROW * ticksPerBar;
            if (cursorTick < rowStart || cursorTick >= rowEnd) return null;
            const cx = X0 + ((cursorTick - rowStart) / (rowEnd - rowStart)) * (STAFF_W - X0);
            return (
              <g>
                <rect x={cx - 7} y={top - 12} width={14} height={(n - 1) * gap + 32} fill={color} opacity="0.09" />
                <line x1={cx} y1={top - 12} x2={cx} y2={top + (n - 1) * gap + 20} stroke={color} strokeWidth="2" opacity="0.95" />
              </g>
            );
          })()}
          {Array.from({ length: BARS_PER_ROW }).map((_, bi) => {
            const barIdx = r * BARS_PER_ROW + bi;
            if (barIdx >= totalBars) return null;
            const bx = X0 + bi * barW;
            const barStart = barIdx * ticksPerBar;
            const evs = byBar[barIdx].slice().sort((a, b) => a.s - b.s);
            const items = [
              <text key="num" x={bx + 4} y={top - 16} fontSize="11" fill="#6a6a72" fontFamily="monospace">{barIdx + 1}</text>,
            ];
            // Sus işaretleri: bar içindeki boşluklar
            const gaps = [];
            let cursor = barStart;
            const real = evs.filter((e) => !e.ghost);
            for (const e of real) {
              if (e.s - cursor >= eighth) gaps.push(cursor);
              cursor = Math.max(cursor, e.s + e.d);
            }
            if (real.length === 0) gaps.push(barStart);
            else if ((barIdx + 1) * ticksPerBar - cursor >= eighth) gaps.push(cursor);
            for (const gs of gaps) {
              const gx = bx + ((gs - barStart) / ticksPerBar) * (barW - 14) + 10;
              const gy = top + ((n - 1) * gap) / 2;
              items.push(
                <g key={`r${gs}`} opacity="0.7">
                  <circle cx={gx} cy={gy - 4} r="1.8" fill="#8a8a96" />
                  <line x1={gx + 4} y1={gy - 6} x2={gx} y2={gy + 7} stroke="#8a8a96" strokeWidth="1.4" />
                </g>
              );
            }
            // Notalar
            for (const e of evs) {
              const p = place(e.m);
              if (!p) continue;
              const x = bx + ((e.s - barStart) / ticksPerBar) * (barW - 14) + 10;
              const y = top + p.idx * gap;
              const label = e.ghost ? `(${p.text})` : String(p.text);
              const w = label.length * (FRET_FS * 0.62) + 6;
              items.push(
                <g key={`${e.s}-${e.m}-${e.ghost ? "g" : "n"}`}>
                  <rect x={x - w / 2} y={y - FRET_FS / 2 - 1} width={w} height={FRET_FS + 2} fill="#0A0A0F" />
                  <text x={x} y={y + FRET_FS * 0.35} fontSize={FRET_FS} fontWeight="700" fill={e.ghost ? "#6a6a76" : "#EEE8D5"} textAnchor="middle" fontFamily="'Courier New', monospace">{label}</text>
                  {e.ghost && (
                    <path d={`M ${x - 20} ${y - 11} Q ${x - 10} ${y - 18} ${x - 1} ${y - 11}`} stroke={color} strokeWidth="1.4" fill="none" opacity="0.85" />
                  )}
                </g>
              );
              // Süre çizgisi (stem) + bayraklar: çeyrek düz, sekizlik 1, on altılık 2
              if (!e.ghost) {
                const sy = top + (n - 1) * gap + 5;
                const flags = e.d < eighth * 0.9 ? 2 : e.d < division * 0.9 ? 1 : 0;
                items.push(<line key={`s${e.s}-${e.m}`} x1={x} y1={sy} x2={x} y2={sy + 11} stroke="#7a7a86" strokeWidth="1.2" />);
                for (let f = 0; f < flags; f++) {
                  items.push(<line key={`f${e.s}-${e.m}-${f}`} x1={x} y1={sy + 11 - f * 3.5} x2={x + 5} y2={sy + 9.5 - f * 3.5} stroke="#7a7a86" strokeWidth="1.2" />);
                }
              }
            }
            return <g key={`bar${bi}`}>{items}</g>;
          })}
        </svg>
      ))}
    </div>
  );
}

// ─── SES SENTEZİ (şarkı çalma) ───────────────────────────────────────────────
function noiseBurst(ctx, out, when, dur, hpFreq, vol) {
  const buf = ctx.createBuffer(1, Math.max(1, Math.ceil(ctx.sampleRate * dur)), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 1.5);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = "highpass";
  f.frequency.value = hpFreq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, when);
  src.connect(f).connect(g).connect(out);
  src.start(when);
}

function synthNote(ctx, partKey, midi, when, dur, vol) {
  const out = ctx.createGain();
  out.gain.value = 1;
  out.connect(ctx.destination);

  if (partKey === "baterist") {
    if (midi === 35 || midi === 36) { // kick
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(110, when);
      o.frequency.exponentialRampToValueAtTime(40, when + 0.1);
      g.gain.setValueAtTime(vol * 0.9, when);
      g.gain.exponentialRampToValueAtTime(0.001, when + 0.15);
      o.connect(g).connect(out);
      o.start(when); o.stop(when + 0.16);
    } else if ([37, 38, 39, 40].includes(midi)) { // snare
      noiseBurst(ctx, out, when, 0.14, 1400, vol * 0.55);
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 190;
      g.gain.setValueAtTime(vol * 0.3, when);
      g.gain.exponentialRampToValueAtTime(0.001, when + 0.09);
      o.connect(g).connect(out);
      o.start(when); o.stop(when + 0.1);
    } else { // hh / zil / tom
      const open = [46, 49, 51, 52, 53, 55, 57, 59].includes(midi);
      const isTom = [41, 43, 45, 47, 48, 50].includes(midi);
      if (isTom) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.setValueAtTime(200 - (50 - midi) * 6, when);
        o.frequency.exponentialRampToValueAtTime(80, when + 0.18);
        g.gain.setValueAtTime(vol * 0.6, when);
        g.gain.exponentialRampToValueAtTime(0.001, when + 0.2);
        o.connect(g).connect(out);
        o.start(when); o.stop(when + 0.21);
      } else {
        noiseBurst(ctx, out, when, open ? 0.35 : 0.05, 6000, vol * (open ? 0.35 : 0.28));
      }
    }
    return;
  }

  const o = ctx.createOscillator();
  const g = ctx.createGain();
  const f = ctx.createBiquadFilter();
  o.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
  let peak = vol * 0.3;
  if (partKey === "bassist") { o.type = "sawtooth"; f.type = "lowpass"; f.frequency.value = 520; peak = vol * 0.5; }
  else if (partKey === "gitarist") { o.type = "sawtooth"; f.type = "lowpass"; f.frequency.value = 1900; peak = vol * 0.28; }
  else if (partKey === "klavye") { o.type = "triangle"; f.type = "lowpass"; f.frequency.value = 3200; peak = vol * 0.34; }
  else { o.type = "sine"; f.type = "lowpass"; f.frequency.value = 4000; peak = vol * 0.34; } // solist / klarnet
  const end = when + Math.min(Math.max(dur, 0.06), 2);
  g.gain.setValueAtTime(0.0001, when);
  g.gain.linearRampToValueAtTime(peak, when + 0.012);
  g.gain.setValueAtTime(peak * 0.75, Math.max(when + 0.013, end - 0.05));
  g.gain.exponentialRampToValueAtTime(0.001, end + 0.06);
  o.connect(f).connect(g).connect(out);
  o.start(when); o.stop(end + 0.09);
}

// ─── METRONOM ────────────────────────────────────────────────────────────────
function Metronome({ song, onClose }) {
  const beatsPerBar = parseInt(song.time.split("/")[0], 10) || 4;
  const [bpm, setBpm] = useState(song.tempo);
  const [running, setRunning] = useState(false);
  const [beat, setBeat] = useState(-1);
  const [sound, setSound] = useState("bip");
  const soundRef = useRef("bip");
  const ctxRef = useRef(null);
  const timerRef = useRef(null);
  const beatRef = useRef(-1);

  useEffect(() => {
    storage.get("martilar-metro-sound")
      .then((r) => { if (r?.value) { setSound(r.value); soundRef.current = r.value; } })
      .catch(() => {});
  }, []);

  const ensureCtx = () => {
    if (!ctxRef.current) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctxRef.current = new AC();
    }
    ctxRef.current.resume();
    return ctxRef.current;
  };

  const pickSound = (id) => {
    setSound(id);
    soundRef.current = id;
    storage.set("martilar-metro-sound", id).catch(() => {});
    playClick(ensureCtx(), true, id); // seçince önizleme
  };

  const click = useCallback((accent) => {
    if (!ctxRef.current) return;
    playClick(ctxRef.current, accent, soundRef.current);
  }, []);

  const stop = useCallback(() => {
    setRunning(false); setBeat(-1); beatRef.current = -1;
    clearInterval(timerRef.current);
  }, []);

  useEffect(() => {
    if (!running) return;
    ensureCtx();
    const tick = () => {
      beatRef.current = (beatRef.current + 1) % beatsPerBar;
      setBeat(beatRef.current);
      click(beatRef.current === 0);
    };
    tick();
    timerRef.current = setInterval(tick, 60000 / bpm);
    return () => clearInterval(timerRef.current);
  }, [running, bpm, beatsPerBar, click]);

  return (
    <div style={st.overlay} onClick={(e) => e.target === e.currentTarget && (stop(), onClose())}>
      <div style={st.sheet}>
        <div style={st.sheetHandle} />
        <div style={st.sheetTitle}>{song.title}</div>
        <div style={{ textAlign: "center", fontSize: 11, color: "#666", fontFamily: "monospace" }}>{song.time}</div>
        <div style={st.beatRow}>
          {Array.from({ length: beatsPerBar }).map((_, i) => (
            <div key={i} style={{ ...st.beatDot, background: beat === i ? (i === 0 ? "#E8C97E" : "#EEE8D5") : "#2a2a35", transform: beat === i ? "scale(1.35)" : "scale(1)", boxShadow: beat === i && i === 0 ? "0 0 18px rgba(232,201,126,.7)" : "none" }} />
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "center", gap: 6, marginBottom: 16 }}>
          {CLICK_TYPES.map((c) => (
            <button key={c.id} onClick={() => pickSound(c.id)}
              style={{ border: "1px solid", borderRadius: 14, padding: "5px 13px", fontSize: 11, fontFamily: "monospace", cursor: "pointer", background: sound === c.id ? "#E8C97E22" : "transparent", color: sound === c.id ? "#E8C97E" : "#666", borderColor: sound === c.id ? "#E8C97E55" : "#ffffff12" }}>
              {c.label}
            </button>
          ))}
        </div>
        <div style={st.bpmRow}>
          <button style={st.bpmBtn} onClick={() => setBpm((b) => Math.max(40, b - 5))}>−5</button>
          <button style={st.bpmBtnSm} onClick={() => setBpm((b) => Math.max(40, b - 1))}>−</button>
          <div style={{ textAlign: "center", minWidth: 88 }}>
            <div style={{ fontSize: 38, fontFamily: "Georgia, serif", color: "#E8C97E" }}>{bpm}</div>
            <div style={{ fontSize: 10, color: "#666", letterSpacing: 2 }}>BPM</div>
          </div>
          <button style={st.bpmBtnSm} onClick={() => setBpm((b) => Math.min(240, b + 1))}>+</button>
          <button style={st.bpmBtn} onClick={() => setBpm((b) => Math.min(240, b + 5))}>+5</button>
        </div>
        <button style={{ ...st.bigBtn, background: running ? "#3a2020" : "#2a2015", borderColor: running ? "#C97E7E66" : "#E8C97E44", color: running ? "#C97E7E" : "#E8C97E" }}
          onClick={() => (running ? stop() : setRunning(true))}>
          {running ? "■ Durdur" : "▶ Başlat"}
        </button>
        <button style={st.sheetClose} onClick={() => { stop(); onClose(); }}>Kapat</button>
      </div>
    </div>
  );
}

// ─── STİLLER ─────────────────────────────────────────────────────────────────
const BG = "#0A0A0F", SURF = "#12121A", SURF2 = "#1A1A24", BORDER = "#ffffff10";
const TEXT = "#EEE8D5", MUTED = "#66666f", GOLD = "#E8C97E";

const css = `
@keyframes ringPulse { 0% { transform: translate(-50%,-50%) scale(.6); opacity:.35 } 100% { transform: translate(-50%,-50%) scale(1.6); opacity:0 } }
@keyframes countPop { 0% { transform: scale(1.5); opacity: 0 } 30% { transform: scale(1); opacity: 1 } 100% { transform: scale(0.85); opacity: 0.7 } }
.count-pop { animation: countPop 0.85s ease-out; }
.gull-ring { animation: ringPulse 2.6s ease-out infinite; }
@media (prefers-reduced-motion: reduce) { .gull-ring { animation: none; opacity:.12 } }
textarea:focus, input:focus, select:focus { outline: 1px solid ${GOLD}55; }
button:focus-visible { outline: 2px solid ${GOLD}; outline-offset: 2px; }
select { appearance: none; }
`;

const st = {
  frame: { display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh", background: "radial-gradient(ellipse at 50% 0%, #101024, #07070c 70%)", fontFamily: "Georgia, serif", padding: 12 },
  phone: { width: 390, height: 844, maxHeight: "96vh", background: BG, borderRadius: 50, overflow: "hidden", boxShadow: "0 40px 120px rgba(0,0,0,.85), 0 0 0 1px #ffffff0a", display: "flex", flexDirection: "column", position: "relative", paddingTop: "env(safe-area-inset-top, 0px)" },
  screen: { flex: 1, overflow: "hidden", position: "relative", display: "flex", flexDirection: "column" },
  loading: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: MUTED, fontSize: 13 },
  col: { height: "100%", display: "flex", flexDirection: "column", background: BG },

  home: { height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", position: "relative", background: `radial-gradient(ellipse at 50% 32%, #191226, ${BG} 72%)`, overflow: "hidden" },
  homeGlow: { position: "absolute", top: "22%", left: "50%", transform: "translateX(-50%)", width: 280, height: 280, borderRadius: "50%", background: "radial-gradient(circle, rgba(232,201,126,.09), transparent 70%)" },
  ring: { position: "absolute", top: "40%", left: "50%", width: 260, height: 260, borderRadius: "50%", border: `1px solid ${GOLD}`, pointerEvents: "none" },
  brand: { color: GOLD, fontSize: 36, letterSpacing: 10, margin: "10px 0 0", fontWeight: 400, textShadow: "0 0 28px rgba(232,201,126,.3)" },
  tagline: { color: MUTED, fontSize: 12, letterSpacing: 5, textTransform: "uppercase", margin: "6px 0 0" },
  divider: { width: 40, height: 1, background: `linear-gradient(90deg, transparent, ${GOLD}, transparent)`, margin: "14px auto" },
  desc: { color: "#888", fontSize: 12.5, lineHeight: 1.7, margin: 0 },
  enterBtn: { marginTop: 26, background: "linear-gradient(135deg,#2a2015,#1a1408)", border: `1px solid ${GOLD}44`, borderRadius: 28, padding: "13px 30px", color: GOLD, fontSize: 15, letterSpacing: 2, fontFamily: "Georgia, serif", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 8 },
  crewRow: { position: "absolute", bottom: 26, display: "flex", gap: 14 },

  header: { display: "flex", alignItems: "center", gap: 12, padding: "14px 18px 10px", borderBottom: `1px solid ${BORDER}`, flexShrink: 0 },
  hTitle: { color: TEXT, fontSize: 19, margin: 0, flex: 1, fontWeight: 400, letterSpacing: 1 },
  addBtn: { background: GOLD + "1c", border: `1px solid ${GOLD}44`, borderRadius: 18, padding: "5px 13px", color: GOLD, fontSize: 12, fontFamily: "Georgia, serif", cursor: "pointer" },
  deleteBtn: { position: "absolute", top: 8, right: 8, width: 22, height: 22, borderRadius: "50%", background: "#2a1515", border: "1px solid #C97E7E44", color: "#C97E7E", fontSize: 14, lineHeight: 1, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 },
  back: { background: "none", border: "none", color: GOLD, fontSize: 26, cursor: "pointer", lineHeight: 1, padding: 0 },
  search: { display: "flex", alignItems: "center", gap: 8, margin: "10px 14px", background: SURF2, border: `1px solid ${BORDER}`, borderRadius: 13, padding: "9px 13px", flexShrink: 0 },
  searchInput: { flex: 1, background: "none", border: "none", color: TEXT, fontSize: 14, fontFamily: "Georgia, serif" },
  clear: { background: "none", border: "none", color: MUTED, fontSize: 17, cursor: "pointer", padding: 0 },
  card: { width: "100%", background: SURF, border: `1px solid ${BORDER}`, borderRadius: 15, padding: 14, marginBottom: 9, display: "flex", justifyContent: "space-between", cursor: "pointer", textAlign: "left", color: TEXT },
  num: { color: GOLD + "55", fontSize: 11, fontFamily: "monospace", marginTop: 3 },
  cardTitle: { fontSize: 16, fontFamily: "Georgia, serif" },
  cardArtist: { fontSize: 12, color: "#999", marginTop: 1 },
  cardMeta: { fontSize: 10, color: MUTED, fontFamily: "monospace", marginTop: 4 },
  tag: { background: GOLD + "14", color: GOLD + "aa", border: `1px solid ${GOLD}22`, borderRadius: 16, padding: "1px 8px", fontSize: 9.5, fontFamily: "monospace" },
  readiness: { fontSize: 11, fontFamily: "monospace", marginBottom: 6 },
  empty: { color: MUTED, textAlign: "center", padding: 40 },

  hero: { padding: "16px 18px 20px", background: "linear-gradient(180deg,#17130a,transparent)", borderBottom: `1px solid ${BORDER}` },
  heroTitle: { color: TEXT, fontSize: 25, marginTop: 8, fontFamily: "Georgia, serif" },
  heroArtist: { color: "#999", fontSize: 13, marginTop: 3 },
  pill: { background: SURF2, border: `1px solid ${BORDER}`, borderRadius: 16, padding: "3px 11px", color: MUTED, fontSize: 11, fontFamily: "monospace" },
  metroBtn: { marginTop: 14, background: "#1a1408", border: `1px solid ${GOLD}44`, borderRadius: 22, padding: "9px 18px", color: GOLD, fontSize: 12, fontFamily: "monospace", cursor: "pointer", letterSpacing: 1 },
  sectionLabel: { color: MUTED, fontSize: 10, letterSpacing: 3, textTransform: "uppercase", padding: "16px 18px 8px", fontFamily: "monospace" },
  partCard: { display: "flex", alignItems: "center", gap: 12, background: SURF, border: "1px solid transparent", borderRadius: 13, padding: "12px 14px", cursor: "pointer", color: TEXT, width: "100%", textAlign: "left" },
  partIcon: { width: 38, height: 38, borderRadius: 11, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 },
  waiting: { fontSize: 9.5, color: "#8a7340", fontFamily: "monospace", background: "#E8C97E12", borderRadius: 10, padding: "2px 7px" },

  partHeader: { display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: "1px solid", flexShrink: 0, color: TEXT },
  iconBtn: { background: SURF2, border: `1px solid ${BORDER}`, borderRadius: 8, color: MUTED, fontSize: 11, padding: "4px 8px", cursor: "pointer", fontFamily: "monospace" },
  tabs: { display: "flex", borderBottom: `1px solid ${BORDER}`, padding: "0 10px", flexShrink: 0, alignItems: "center" },
  tab: { padding: "9px 12px", background: "none", border: "none", borderBottom: "2px solid transparent", cursor: "pointer", fontSize: 15 },
  noteBanner: { margin: "10px 14px 0", padding: "8px 11px", background: SURF2, borderLeft: "3px solid", borderRadius: "0 8px 8px 0", flexShrink: 0 },
  progressTrack: { height: 2, background: SURF2, margin: "8px 14px 0", borderRadius: 2, flexShrink: 0 },
  progressBar: { height: "100%", borderRadius: 2, minWidth: 14, transition: "width .1s" },
  pre: { color: TEXT, fontFamily: "'Courier New', monospace", lineHeight: 1.75, margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" },
  practicePanel: { padding: "10px 16px 12px", borderTop: "1px solid #7EC97E33", background: "#0c140c", flexShrink: 0 },
  emptyPart: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: 20 },
  editor: { flex: 1, background: SURF, border: `1px solid ${BORDER}`, borderRadius: 12, color: TEXT, fontFamily: "'Courier New', monospace", fontSize: 12, padding: 12, resize: "none", lineHeight: 1.6 },
  notesInput: { background: SURF, border: `1px solid ${BORDER}`, borderRadius: 10, color: TEXT, fontSize: 12, padding: "9px 12px", fontFamily: "Georgia, serif" },
  saveBtn: { flex: 1, background: "#1a2a15", border: "1px solid #7EC97E55", borderRadius: 12, color: "#7EC97E", padding: "11px 0", fontSize: 14, cursor: "pointer", fontFamily: "Georgia, serif" },
  cancelBtn: { flex: 1, background: SURF2, border: `1px solid ${BORDER}`, borderRadius: 12, color: MUTED, padding: "11px 0", fontSize: 14, cursor: "pointer", fontFamily: "Georgia, serif" },

  playBar: { display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderTop: "1px solid", flexShrink: 0, background: "#0d0d14" },
  playCtl: { width: 44, height: 44, borderRadius: "50%", background: "#17130a", border: "1px solid", fontSize: 16, cursor: "pointer", flexShrink: 0 },
  speedChip: { border: "1px solid", borderRadius: 14, padding: "4px 8px", fontSize: 10.5, fontFamily: "monospace", cursor: "pointer", background: "none" },

  overlay: { position: "absolute", inset: 0, background: "rgba(5,5,10,.74)", display: "flex", alignItems: "flex-end", zIndex: 20 },
  sheet: { width: "100%", background: "#14141d", borderRadius: "26px 26px 0 0", padding: "10px 22px 24px", border: `1px solid ${BORDER}`, borderBottom: "none", maxHeight: "88%", overflowY: "auto" },
  sheetHandle: { width: 38, height: 4, borderRadius: 3, background: "#333", margin: "4px auto 14px" },
  sheetTitle: { textAlign: "center", fontFamily: "Georgia, serif", fontSize: 16, color: TEXT },
  sheetClose: { width: "100%", marginTop: 8, background: "none", border: "none", color: MUTED, fontSize: 12, cursor: "pointer", padding: 8 },

  beatRow: { display: "flex", justifyContent: "center", gap: 14, margin: "20px 0" },
  beatDot: { width: 15, height: 15, borderRadius: "50%", transition: "all .09s" },
  bpmRow: { display: "flex", alignItems: "center", justifyContent: "center", gap: 10 },
  bpmBtn: { background: SURF2, border: `1px solid ${BORDER}`, borderRadius: 12, color: TEXT, fontSize: 14, padding: "10px 13px", cursor: "pointer", fontFamily: "monospace" },
  bpmBtnSm: { background: "none", border: `1px solid ${BORDER}`, borderRadius: 10, color: MUTED, fontSize: 15, padding: "7px 12px", cursor: "pointer" },
  bigBtn: { width: "100%", marginTop: 18, background: "#2a2015", border: `1px solid ${GOLD}44`, borderRadius: 16, padding: "14px 0", fontSize: 15, fontFamily: "Georgia, serif", letterSpacing: 2, cursor: "pointer", color: GOLD },

  formInput: { width: "100%", boxSizing: "border-box", background: SURF, border: `1px solid ${BORDER}`, borderRadius: 11, color: TEXT, fontSize: 13, padding: "10px 13px", fontFamily: "Georgia, serif", marginTop: 8 },
  instChip: { background: SURF, border: "1px solid", borderRadius: 18, padding: "6px 11px", fontSize: 11.5, cursor: "pointer", fontFamily: "Georgia, serif" },

  toggleRow: { display: "flex", justifyContent: "space-between", alignItems: "center", margin: "6px 4px" },
  toggle: { border: "none", borderRadius: 14, padding: "5px 14px", fontSize: 11, cursor: "pointer", fontFamily: "monospace" },
  resultGrid: { display: "flex", gap: 8, marginTop: 14 },
  resultCell: { flex: 1, background: SURF, border: `1px solid ${BORDER}`, borderRadius: 12, padding: "10px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, fontSize: 10, color: MUTED, fontFamily: "monospace" },
};
