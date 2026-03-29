import Dexie from 'https://unpkg.com/dexie@4/dist/dexie.mjs';

const db = new Dexie('p2p-chat');

db.version(1).stores({
  identity: 'id',
  rooms: 'id, createdAt',
  contacts: 'id, lastSeen',
  messages: '++id, roomId, createdAt'
});

db.version(2).stores({
  identity: 'id',
  rooms: 'id, createdAt',
  contacts: 'id, lastSeen',
  messages: '++id, roomId, createdAt',
  files: 'transferId, roomId, createdAt'
});

export async function getOrCreateIdentity() {
  let identity = await db.identity.get('self');
  if (!identity) {
    const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 4).toUpperCase();
    identity = { id: 'self', userId: crypto.randomUUID(), name: `User_${suffix}` };
    await db.identity.put(identity);
  }
  return identity;
}

export async function updateIdentityName(name) {
  await db.identity.update('self', { name });
}

export async function saveRoom(room) {
  await db.rooms.put(room);
}

export async function getRoom(id) {
  return db.rooms.get(id);
}

export async function getRecentRooms(limit = 10) {
  return db.rooms.orderBy('createdAt').reverse().limit(limit).toArray();
}

export async function saveContact(contact) {
  await db.contacts.put({ ...contact, lastSeen: Date.now() });
}

export async function getContact(id) {
  return db.contacts.get(id);
}

export async function saveMessage(message) {
  return db.messages.add(message);
}

export async function getMessages(roomId) {
  return db.messages.where('roomId').equals(roomId).sortBy('createdAt');
}

export async function deleteMessages(roomId) {
  await db.messages.where('roomId').equals(roomId).delete();
}

export async function saveFile(fileRecord) {
  await db.files.put(fileRecord);
}

export async function getFiles(roomId) {
  return db.files.where('roomId').equals(roomId).sortBy('createdAt');
}

export async function deleteFiles(roomId) {
  await db.files.where('roomId').equals(roomId).delete();
}

export async function updateRoomName(id, name) {
  await db.rooms.update(id, { name });
}

export async function deleteRoom(id) {
  await db.messages.where('roomId').equals(id).delete();
  await db.files.where('roomId').equals(id).delete();
  await db.rooms.delete(id);
}

export default db;
