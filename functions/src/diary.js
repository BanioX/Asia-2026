// Travel diary storage: the written entry lives in Firestore, photos in Cloud Storage.
// Each day belongs to exactly one user, and the session token decides which diary is
// touched – a request can never name a different one.
import { randomUUID } from 'node:crypto';

const dayId = (user, date) => `${user}_${date}`;
const photoPath = (user, date, id) => `diary/${user}/${date}/${id}`;

/** Thrown for cases the HTTP layer maps to a specific status. */
export class DiaryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function createDiary({ db, bucket, limits, now = () => Date.now() }) {
  const days = () => db.collection('diary');
  const strip = ({ user, ...rest }) => rest; // the caller already knows whose diary this is

  async function readDay(user, date) {
    const doc = await days().doc(dayId(user, date)).get();
    return doc.exists ? doc.data() : null;
  }

  return {
    /** Every day of one diary, newest first. */
    async list(user) {
      const snap = await days().where('user', '==', user).get();
      return snap.docs
        .map((d) => strip(d.data()))
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    },

    /** Create or update the written part of a day. Photos are untouched. */
    async save(user, { date, text, mood, expenses }) {
      const ref = days().doc(dayId(user, date));
      const existing = await readDay(user, date);
      const day = {
        user,
        date,
        text,
        mood,
        expenses,
        photos: existing?.photos ?? [],
        updatedAt: now(),
      };
      await ref.set(day, { merge: true });
      return strip(day);
    },

    async addPhoto(user, { date, mimeType, data, caption }) {
      const existing = await readDay(user, date);
      const photos = existing?.photos ?? [];
      if (photos.length >= limits.maxDiaryPhotosPerDay) {
        throw new DiaryError('too_many_photos', `Pro Tag sind ${limits.maxDiaryPhotosPerDay} Fotos möglich.`);
      }
      const photo = { id: randomUUID(), caption, mimeType, createdAt: now() };
      await bucket.file(photoPath(user, date, photo.id)).save(Buffer.from(data, 'base64'), {
        contentType: mimeType,
        resumable: false,
      });
      await days().doc(dayId(user, date)).set(
        { user, date, photos: [...photos, photo], updatedAt: now() },
        { merge: true },
      );
      return photo;
    },

    /** Returns null when the photo does not exist in this user's diary. */
    async getPhoto(user, { date, id }) {
      const day = await readDay(user, date);
      const meta = (day?.photos ?? []).find((p) => p.id === id);
      if (!meta) return null;
      const file = bucket.file(photoPath(user, date, id));
      const [exists] = await file.exists();
      if (!exists) return null;
      const [buf] = await file.download();
      return { mimeType: meta.mimeType, caption: meta.caption, data: buf.toString('base64') };
    },

    async removePhoto(user, { date, id }) {
      const day = await readDay(user, date);
      if (!day || !(day.photos ?? []).some((p) => p.id === id)) return false;
      await days().doc(dayId(user, date)).set(
        { photos: day.photos.filter((p) => p.id !== id), updatedAt: now() },
        { merge: true },
      );
      // The file is best effort: the entry is already gone from the diary either way.
      try {
        await bucket.file(photoPath(user, date, id)).delete();
      } catch { /* already gone */ }
      return true;
    },
  };
}
