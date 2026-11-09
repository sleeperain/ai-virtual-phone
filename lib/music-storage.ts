// lib/music-storage.ts — IndexedDB local music storage (audio blobs + metadata)

import { openIndexedDbAtLeast } from "./idb-open";

export type MusicTrack = {
    id: string;
    title: string;
    artist: string;
    album?: string;
    duration: number;        // seconds
    coverUrl?: string;       // data URL or blob URL
    lyrics?: string;         // LRC format or plain text
    tlyrics?: string;        // Translated LRC format
    liked: boolean;
    addedAt: string;         // ISO timestamp
    lastPlayedAt?: string;   // ISO timestamp
};

/**
 * 把任意来源的曲目对象收敛成合法的 MusicTrack。
 *
 * 来源有三类，都不能假设字段齐全：IndexedDB 里老版本存下的元数据（那时候还没有
 * tlyrics 字段）、设置里的备份 JSON 导入、以及播放队列的 localStorage 快照。
 * 只要有一个字段是 null / 类型不对，下游（歌词解析、时长格式化）就会在渲染期抛错，
 * 而渲染期抛错会一路冒到根节点把整页打崩。所以入口处一律归一：
 * - id 缺失 → 整条丢弃（没有 id 的曲目无法播放也无法去重）
 * - 文本字段非字符串 → 当作"没有"，绝不留 null 给下游
 * - 数字字段非法 → 0
 */
export function normalizeMusicTrack(raw: unknown): MusicTrack | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const source = raw as Record<string, unknown>;

    const id = typeof source.id === "string" ? source.id.trim() : "";
    if (!id) return null;

    const title = typeof source.title === "string" && source.title.trim() ? source.title : "未知曲目";
    const artist = typeof source.artist === "string" ? source.artist : "";
    const duration = typeof source.duration === "number" && Number.isFinite(source.duration) && source.duration >= 0
        ? source.duration
        : 0;
    const addedAt = typeof source.addedAt === "string" && source.addedAt ? source.addedAt : new Date(0).toISOString();

    const track: MusicTrack = {
        id,
        title,
        artist,
        duration,
        liked: source.liked === true,
        addedAt,
    };

    // 歌词是崩溃高发字段（老数据没有 / 接口回 null 被写进来的），只认字符串
    if (typeof source.lyrics === "string") track.lyrics = source.lyrics;
    if (typeof source.tlyrics === "string") track.tlyrics = source.tlyrics;
    if (typeof source.album === "string" && source.album) track.album = source.album;
    if (typeof source.coverUrl === "string" && source.coverUrl) track.coverUrl = source.coverUrl;
    if (typeof source.lastPlayedAt === "string" && source.lastPlayedAt) track.lastPlayedAt = source.lastPlayedAt;

    return track;
}

/** 批量归一，顺手丢掉无效条目 */
export function normalizeMusicTracks(rawList: unknown): MusicTrack[] {
    if (!Array.isArray(rawList)) return [];
    const out: MusicTrack[] = [];
    for (const item of rawList) {
        const track = normalizeMusicTrack(item);
        if (track) out.push(track);
    }
    return out;
}

// ── IndexedDB Setup ──

const DB_NAME = "ai_phone_music_db_v1";
const DB_VERSION = 2;
const META_STORE = "tracks";
const AUDIO_STORE = "audio_blobs";

function openDb(): Promise<IDBDatabase | null> {
    if (typeof window === "undefined") return Promise.resolve(null);
    // Open at >= DB_VERSION: a backup restore may have bumped the stored version
    // higher, and opening at a fixed lower version would throw a VersionError.
    return openIndexedDbAtLeast(DB_NAME, DB_VERSION, (db) => {
        if (!db.objectStoreNames.contains(META_STORE)) {
            db.createObjectStore(META_STORE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(AUDIO_STORE)) {
            db.createObjectStore(AUDIO_STORE);
        }
    }).catch((err) => { console.warn("[Music] DB open error:", err); return null; });
}

function runRequest<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

// ── CRUD ──

export async function loadAllTracks(): Promise<MusicTrack[]> {
    const db = await openDb();
    if (!db) return [];
    const tx = db.transaction(META_STORE, "readonly");
    const stored: unknown = await runRequest(tx.objectStore(META_STORE).getAll());
    // 库里可能躺着老版本写的记录（没有 tlyrics / 字段存成了 null），读出来一律先归一，
    // 免得把 null 一路带到渲染层。
    const tracks = normalizeMusicTracks(stored);
    tracks.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
    return tracks;
}

export async function saveTrack(track: MusicTrack, audioBlob: Blob): Promise<void> {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction([META_STORE, AUDIO_STORE], "readwrite");
    tx.objectStore(META_STORE).put(track);
    tx.objectStore(AUDIO_STORE).put(audioBlob, track.id);
    await new Promise<void>((res, rej) => {
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
    });
}

export async function deleteTrack(trackId: string): Promise<void> {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction([META_STORE, AUDIO_STORE], "readwrite");
    tx.objectStore(META_STORE).delete(trackId);
    tx.objectStore(AUDIO_STORE).delete(trackId);
    await new Promise<void>((res, rej) => {
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
    });
}

export async function getAudioBlob(trackId: string): Promise<Blob | null> {
    const db = await openDb();
    if (!db) return null;
    const tx = db.transaction(AUDIO_STORE, "readonly");
    const blob = await runRequest(tx.objectStore(AUDIO_STORE).get(trackId));
    return blob instanceof Blob ? blob : null;
}

export async function updateTrackMeta(trackId: string, updates: Partial<MusicTrack>): Promise<void> {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction(META_STORE, "readwrite");
    const store = tx.objectStore(META_STORE);
    const existing: MusicTrack | undefined = await runRequest(store.get(trackId));
    if (!existing) return;
    store.put({ ...existing, ...updates, id: trackId });
    await new Promise<void>((res, rej) => {
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
    });
}

export async function markTrackPlayed(trackId: string, playedAt = new Date().toISOString()): Promise<void> {
    await updateTrackMeta(trackId, { lastPlayedAt: playedAt });
}

export async function toggleLike(trackId: string): Promise<boolean> {
    const db = await openDb();
    if (!db) return false;
    const tx = db.transaction(META_STORE, "readwrite");
    const store = tx.objectStore(META_STORE);
    const track: MusicTrack | undefined = await runRequest(store.get(trackId));
    if (!track) return false;
    track.liked = !track.liked;
    store.put(track);
    await new Promise<void>((res, rej) => {
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
    });
    return track.liked;
}

// ── Helpers ──

export function generateTrackId(): string {
    return `trk_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Parse filename into title and artist: "Artist - Title.mp3" */
export function parseFilename(filename: string): { title: string; artist: string } {
    const name = filename.replace(/\.[^.]+$/, "").trim();
    const sep = name.indexOf(" - ");
    if (sep > 0) {
        return { artist: name.slice(0, sep).trim(), title: name.slice(sep + 3).trim() };
    }
    return { title: name, artist: "未知歌手" };
}

/** Get audio duration from a blob */
export function getAudioDuration(blob: Blob): Promise<number> {
    return new Promise((resolve) => {
        const audio = new Audio();
        audio.addEventListener("loadedmetadata", () => {
            resolve(audio.duration || 0);
            URL.revokeObjectURL(audio.src);
        });
        audio.addEventListener("error", () => {
            resolve(0);
            URL.revokeObjectURL(audio.src);
        });
        audio.src = URL.createObjectURL(blob);
    });
}
