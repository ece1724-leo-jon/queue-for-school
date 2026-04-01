import cors from 'cors';
import express, { type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { Server, type Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';

type QueueType = 'marking' | 'question';
type QueueSelection = QueueType | 'combined';
type EntryStatus = 'waiting' | 'called' | 'assisting';

interface Follower {
  userId: string;
  name: string;
}

interface BaseQueueEntry {
  id: string;
  name: string;
  email: string | null;
  joinedAt: string;
  userId: string;
  status: EntryStatus;
}

interface MarkingEntry extends BaseQueueEntry {
  studentId: string;
}

interface QuestionEntry extends BaseQueueEntry {
  description: string | null;
  followers: Follower[];
}

type QueueEntry = MarkingEntry | QuestionEntry;

interface RoomData {
  marking: MarkingEntry[];
  question: QuestionEntry[];
  password: string | null;
}

interface RoomSummary {
  name: string;
  markingCount: number;
  questionCount: number;
  hasPassword: boolean;
}

interface JoinedQueuePayload {
  queueType: QueueType;
  position: number;
  entryId: string;
}

interface RestoreEntryInfo {
  entryId: string;
  position: number;
  status: EntryStatus;
}

interface JoinMarkingPayload {
  name?: string;
  studentId?: string;
  email?: string | null;
  userId?: string;
  room?: string;
}

interface JoinQuestionPayload {
  name?: string;
  email?: string | null;
  description?: string | null;
  userId?: string;
  room?: string;
}

interface LeaveQueuePayload {
  queueType?: QueueType;
  entryId?: string;
  userId?: string;
  room?: string;
}

interface FollowQuestionPayload {
  entryId?: string;
  userId?: string;
  name?: string;
  room?: string;
}

interface PushBackPayload {
  queueType?: QueueType;
  entryId?: string;
  userId?: string;
  room?: string;
}

interface TAQueuePayload {
  queueType?: QueueSelection;
  room?: string;
}

interface TASpecificPayload extends TAQueuePayload {
  entryId?: string;
}

interface RegisterUserPayload {
  userId?: string;
  room?: string;
}

interface ClaimRoomBody {
  room?: string;
  masterPassword?: string;
  newPassword?: string | null;
}

interface RoomAuthBody {
  room?: string;
  password?: string;
}

interface UserRoomEntry {
  room: string;
  queueType: QueueType;
  entry: QueueEntry;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = path.join(__dirname, 'queue_data.json');
const DIST_PATH = path.join(__dirname, '..', 'dist');
const MASTER_PASSWORD = process.env.TA_PASSWORD ?? 'ece297ta';
const PORT = Number(process.env.PORT ?? 3001);

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

let rooms = new Map<string, RoomData>();
let isSaving = false;
let saveScheduled = false;

const userSockets = new Map<string, Set<string>>();

const createEmptyRoom = (): RoomData => ({
  marking: [],
  question: [],
  password: null,
});

const isQueueType = (value: unknown): value is QueueType =>
  value === 'marking' || value === 'question';

const isQueueSelection = (value: unknown): value is QueueSelection =>
  value === 'marking' || value === 'question' || value === 'combined';

const isWaitingLike = (status: EntryStatus): boolean =>
  status === 'waiting' || status === 'called';

const normalizeFollower = (value: unknown): Follower | null => {
  if (!value || typeof value !== 'object') return null;
  const userId = typeof (value as { userId?: unknown }).userId === 'string'
    ? (value as { userId: string }).userId
    : null;
  const name = typeof (value as { name?: unknown }).name === 'string'
    ? (value as { name: string }).name
    : null;

  if (!userId || !name) return null;
  return { userId, name };
};

const normalizeMarkingEntry = (value: unknown): MarkingEntry | null => {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Partial<MarkingEntry>;

  if (
    typeof entry.id !== 'string' ||
    typeof entry.name !== 'string' ||
    typeof entry.studentId !== 'string' ||
    typeof entry.joinedAt !== 'string' ||
    typeof entry.userId !== 'string'
  ) {
    return null;
  }

  const status: EntryStatus =
    entry.status === 'called' || entry.status === 'assisting' ? entry.status : 'waiting';

  return {
    id: entry.id,
    name: entry.name,
    studentId: entry.studentId,
    email: typeof entry.email === 'string' ? entry.email : null,
    joinedAt: entry.joinedAt,
    userId: entry.userId,
    status,
  };
};

const normalizeQuestionEntry = (value: unknown): QuestionEntry | null => {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Partial<QuestionEntry>;

  if (
    typeof entry.id !== 'string' ||
    typeof entry.name !== 'string' ||
    typeof entry.joinedAt !== 'string' ||
    typeof entry.userId !== 'string'
  ) {
    return null;
  }

  const status: EntryStatus =
    entry.status === 'called' || entry.status === 'assisting' ? entry.status : 'waiting';

  return {
    id: entry.id,
    name: entry.name,
    email: typeof entry.email === 'string' ? entry.email : null,
    description: typeof entry.description === 'string' ? entry.description : null,
    joinedAt: entry.joinedAt,
    userId: entry.userId,
    status,
    followers: Array.isArray(entry.followers)
      ? entry.followers.map(normalizeFollower).filter((follower): follower is Follower => follower !== null)
      : [],
  };
};

const normalizeRoom = (value: unknown): RoomData => {
  if (!value || typeof value !== 'object') return createEmptyRoom();

  const room = value as Partial<RoomData>;
  return {
    marking: Array.isArray(room.marking)
      ? room.marking.map(normalizeMarkingEntry).filter((entry): entry is MarkingEntry => entry !== null)
      : [],
    question: Array.isArray(room.question)
      ? room.question.map(normalizeQuestionEntry).filter((entry): entry is QuestionEntry => entry !== null)
      : [],
    password: typeof room.password === 'string' ? room.password : null,
  };
};

const saveQueues = (): void => {
  if (isSaving) {
    saveScheduled = true;
    return;
  }

  isSaving = true;
  const serialized = Object.fromEntries(rooms);
  const tempFile = `${DATA_FILE}.tmp`;

  fs.writeFile(tempFile, JSON.stringify(serialized, null, 2), (writeError) => {
    if (writeError) {
      console.error('Error writing temp queue data:', writeError);
      isSaving = false;
      return;
    }

    fs.rename(tempFile, DATA_FILE, (renameError) => {
      isSaving = false;

      if (renameError) {
        console.error('Error renaming queue data file:', renameError);
      }

      if (saveScheduled) {
        saveScheduled = false;
        saveQueues();
      }
    });
  });
};

const loadQueues = (): void => {
  try {
    if (!fs.existsSync(DATA_FILE)) return;

    const data = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(data) as Record<string, unknown>;
    rooms = new Map(
      Object.entries(parsed).map(([roomName, roomData]) => [roomName, normalizeRoom(roomData)]),
    );
    console.log('Queue data loaded from disk.');
  } catch (error) {
    console.error('Error loading queue data:', error);
  }
};

const getRoom = (roomName: string): RoomData => {
  if (!rooms.has(roomName)) {
    rooms.set(roomName, createEmptyRoom());
  }

  return rooms.get(roomName)!;
};

const registerUserSocket = (userId: string, socketId: string): void => {
  if (!userSockets.has(userId)) {
    userSockets.set(userId, new Set());
  }

  userSockets.get(userId)!.add(socketId);
};

const unregisterUserSocket = (userId: string, socketId: string): void => {
  const sockets = userSockets.get(userId);
  if (!sockets) return;

  sockets.delete(socketId);
  if (sockets.size === 0) {
    userSockets.delete(userId);
  }
};

const emitToUser = (userId: string, event: string, data: unknown): void => {
  const sockets = userSockets.get(userId);
  if (!sockets) return;

  sockets.forEach((socketId) => {
    io.to(socketId).emit(event, data);
  });
};

const findUserInAnyRoom = (userId: string): UserRoomEntry | null => {
  for (const [roomName, roomData] of rooms.entries()) {
    const markingEntry = roomData.marking.find((entry) => entry.userId === userId);
    if (markingEntry) {
      return { room: roomName, queueType: 'marking', entry: markingEntry };
    }

    const questionEntry = roomData.question.find((entry) => entry.userId === userId);
    if (questionEntry) {
      return { room: roomName, queueType: 'question', entry: questionEntry };
    }
  }

  return null;
};

const removeUserFromRoom = (userId: string, roomName: string): boolean => {
  const room = rooms.get(roomName);
  if (!room) return false;

  let removed = false;

  const markingIndex = room.marking.findIndex((entry) => entry.userId === userId);
  if (markingIndex !== -1) {
    room.marking.splice(markingIndex, 1);
    removed = true;
  }

  const questionIndex = room.question.findIndex((entry) => entry.userId === userId);
  if (questionIndex !== -1) {
    room.question.splice(questionIndex, 1);
    removed = true;
  }

  room.question.forEach((entry) => {
    const followerIndex = entry.followers.findIndex((follower) => follower.userId === userId);
    if (followerIndex !== -1) {
      entry.followers.splice(followerIndex, 1);
      removed = true;
    }
  });

  return removed;
};

const buildRoomList = (): RoomSummary[] =>
  Array.from(rooms.entries()).map(([name, data]) => ({
    name,
    markingCount: data.marking.length,
    questionCount: data.question.length,
    hasPassword: Boolean(data.password),
  }));

const broadcastRoomsList = (): void => {
  io.emit('rooms-list-update', buildRoomList());
};

const withPositions = <T extends QueueEntry>(queue: T[]): Array<T & { position: number }> => {
  let waitingCount = 0;

  return queue.map((entry) => {
    if (isWaitingLike(entry.status)) {
      waitingCount += 1;
      return { ...entry, position: waitingCount };
    }

    return { ...entry, position: 0 };
  });
};

const getActivePosition = (queue: QueueEntry[], entry: QueueEntry): number => {
  if (!isWaitingLike(entry.status)) return 0;
  return queue.filter((item) => isWaitingLike(item.status)).indexOf(entry) + 1;
};

const broadcastQueues = (roomName: string): void => {
  const room = rooms.get(roomName);
  if (!room) return;

  io.to(roomName).emit('queues-update', {
    marking: withPositions(room.marking),
    question: withPositions(room.question),
  });

  broadcastRoomsList();
};

const notifyUpcoming = (queueType: QueueType, position: number, userId: string): void => {
  if (queueType === 'question') return;
  if (position !== 1 && position !== 2) return;

  emitToUser(userId, 'turn-approaching', {
    queueType,
    position,
    message:
      position === 1
        ? "You're next! Please stay on the page."
        : 'Be prepared. Only one person is ahead of you.',
  });
};

const notifyNextStudents = (roomName: string, queueType: QueueType): void => {
  const room = rooms.get(roomName);
  if (!room) return;

  room[queueType]
    .filter((entry) => entry.status === 'waiting')
    .slice(0, 3)
    .forEach((entry, index) => {
      notifyUpcoming(queueType, index + 1, entry.userId);
    });
};

const pushBackInQueue = <T extends QueueEntry>(queue: T[], entryId: string): number | null => {
  const index = queue.findIndex((entry) => entry.id === entryId);
  if (index === -1 || queue[index]?.status !== 'waiting') return null;

  const item = queue[index];
  const newIndex = Math.min(index + 1, queue.length - 1);
  if (newIndex === index) return null;

  queue.splice(index, 1);
  queue.splice(newIndex, 0, item);

  if (newIndex > 0) {
    const previousEntry = queue[newIndex - 1];
    item.joinedAt = new Date(new Date(previousEntry.joinedAt).getTime() + 1000).toISOString();
  }

  return newIndex + 1;
};

const findEntry = (room: RoomData, queueType: QueueSelection, entryId: string): {
  entry: QueueEntry | null;
  realType: QueueType | null;
} => {
  if (queueType === 'combined') {
    const markingEntry = room.marking.find((entry) => entry.id === entryId);
    if (markingEntry) return { entry: markingEntry, realType: 'marking' };

    const questionEntry = room.question.find((entry) => entry.id === entryId);
    if (questionEntry) return { entry: questionEntry, realType: 'question' };

    return { entry: null, realType: null };
  }

  const entry = room[queueType].find((item) => item.id === entryId) ?? null;
  return { entry, realType: entry ? queueType : null };
};

const requireString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const optionalString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const getQueryString = (value: unknown): string | null => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].trim()) return value[0].trim();
  return null;
};

loadQueues();

io.on('connection', (socket: Socket) => {
  console.log(`Client connected: ${socket.id}`);

  let currentUserId: string | null = null;

  socket.on('register-user', (payload: RegisterUserPayload = {}) => {
    const room = requireString(payload.room);
    const userId = requireString(payload.userId);
    if (!room || !userId) return;

    currentUserId = userId;
    socket.join(room);
    registerUserSocket(userId, socket.id);
    console.log(`User ${userId} registered in room ${room}`);

    if (!rooms.has(room)) return;

    broadcastQueues(room);
    const roomData = rooms.get(room)!;

    const getEntryInfo = (queue: QueueEntry[]): RestoreEntryInfo | null => {
      const entry = queue.find((item) => item.userId === userId);
      if (!entry) return null;

      return {
        entryId: entry.id,
        position: getActivePosition(queue, entry),
        status: entry.status,
      };
    };

    socket.emit('restore-entries', {
      marking: getEntryInfo(roomData.marking),
      question: getEntryInfo(roomData.question),
    });
  });

  socket.on('join-marking', (payload: JoinMarkingPayload = {}) => {
    const roomName = requireString(payload.room);
    const userId = requireString(payload.userId);
    const name = requireString(payload.name);
    const studentId = requireString(payload.studentId);
    if (!roomName || !userId || !name || !studentId) return;

    const room = getRoom(roomName);

    if (room.marking.some((entry) => entry.userId === userId)) {
      socket.emit('error', { message: 'You are already in the marking queue.' });
      return;
    }

    const otherRoomEntry = findUserInAnyRoom(userId);
    if (otherRoomEntry && otherRoomEntry.room !== roomName) {
      socket.emit('error', {
        message: `You are already in a queue in room "${otherRoomEntry.room}". Please leave that queue first before joining another room.`,
        existingRoom: otherRoomEntry.room,
        existingQueueType: otherRoomEntry.queueType,
      });
      return;
    }

    const entry: MarkingEntry = {
      id: uuidv4(),
      name,
      studentId,
      email: optionalString(payload.email),
      joinedAt: new Date().toISOString(),
      userId,
      status: 'waiting',
    };

    room.marking.push(entry);
    saveQueues();
    broadcastQueues(roomName);

    const joinedPayload: JoinedQueuePayload = {
      queueType: 'marking',
      position: room.marking.length,
      entryId: entry.id,
    };

    emitToUser(userId, 'joined-queue', joinedPayload);
  });

  socket.on('join-question', (payload: JoinQuestionPayload = {}) => {
    const roomName = requireString(payload.room);
    const userId = requireString(payload.userId);
    const name = requireString(payload.name);
    if (!roomName || !userId || !name) return;

    const room = getRoom(roomName);

    if (room.question.some((entry) => entry.userId === userId)) {
      socket.emit('error', { message: 'You are already in the question queue.' });
      return;
    }

    const otherRoomEntry = findUserInAnyRoom(userId);
    if (otherRoomEntry && otherRoomEntry.room !== roomName) {
      socket.emit('error', {
        message: `You are already in a queue in room "${otherRoomEntry.room}". Please leave that queue first before joining another room.`,
        existingRoom: otherRoomEntry.room,
        existingQueueType: otherRoomEntry.queueType,
      });
      return;
    }

    const entry: QuestionEntry = {
      id: uuidv4(),
      name,
      email: optionalString(payload.email),
      description: optionalString(payload.description),
      joinedAt: new Date().toISOString(),
      userId,
      status: 'waiting',
      followers: [],
    };

    room.question.push(entry);
    saveQueues();
    broadcastQueues(roomName);

    emitToUser(userId, 'joined-queue', {
      queueType: 'question',
      position: room.question.length,
      entryId: entry.id,
    } satisfies JoinedQueuePayload);
  });

  socket.on('leave-queue', (payload: LeaveQueuePayload = {}) => {
    const roomName = requireString(payload.room);
    const entryId = requireString(payload.entryId);
    const userId = requireString(payload.userId);
    if (!roomName || !entryId || !userId || !isQueueType(payload.queueType)) return;

    const room = getRoom(roomName);
    const queue = room[payload.queueType];
    const index = queue.findIndex((entry) => entry.id === entryId);
    if (index === -1) return;

    queue.splice(index, 1);
    saveQueues();
    emitToUser(userId, 'left-queue', { queueType: payload.queueType, entryId });
    broadcastQueues(roomName);
    notifyNextStudents(roomName, payload.queueType);
  });

  socket.on('follow-question', (payload: FollowQuestionPayload = {}) => {
    const roomName = requireString(payload.room);
    const entryId = requireString(payload.entryId);
    const userId = requireString(payload.userId);
    const name = requireString(payload.name);
    if (!roomName || !entryId || !userId || !name) return;

    const otherRoomEntry = findUserInAnyRoom(userId);
    if (otherRoomEntry && otherRoomEntry.room !== roomName) {
      socket.emit('error', {
        message: `You cannot follow questions while in a queue in room "${otherRoomEntry.room}". Please leave that queue first.`,
        existingRoom: otherRoomEntry.room,
        existingQueueType: otherRoomEntry.queueType,
      });
      return;
    }

    const room = getRoom(roomName);
    const entry = room.question.find((item) => item.id === entryId);
    if (!entry || entry.userId === userId || entry.followers.some((follower) => follower.userId === userId)) {
      socket.emit('error', { message: 'Cannot follow question.' });
      return;
    }

    entry.followers.push({ userId, name });
    saveQueues();
    broadcastQueues(roomName);
    emitToUser(userId, 'following-question', { entryId });
  });

  socket.on('unfollow-question', (payload: FollowQuestionPayload = {}) => {
    const roomName = requireString(payload.room);
    const entryId = requireString(payload.entryId);
    const userId = requireString(payload.userId);
    if (!roomName || !entryId || !userId) return;

    const room = getRoom(roomName);
    const entry = room.question.find((item) => item.id === entryId);
    if (!entry) return;

    const followerIndex = entry.followers.findIndex((follower) => follower.userId === userId);
    if (followerIndex === -1) return;

    entry.followers.splice(followerIndex, 1);
    saveQueues();
    broadcastQueues(roomName);
    emitToUser(userId, 'unfollowed-question', { entryId });
  });

  socket.on('push-back', (payload: PushBackPayload = {}) => {
    const roomName = requireString(payload.room);
    const entryId = requireString(payload.entryId);
    const userId = requireString(payload.userId);
    if (!roomName || !entryId || !userId || !isQueueType(payload.queueType)) return;

    const room = getRoom(roomName);
    const newPosition =
      payload.queueType === 'marking'
        ? pushBackInQueue(room.marking, entryId)
        : pushBackInQueue(room.question, entryId);
    if (!newPosition) return;

    saveQueues();
    broadcastQueues(roomName);
    emitToUser(userId, 'pushed-back', { queueType: payload.queueType, position: newPosition });
  });

  socket.on('ta-checkin', (payload: TAQueuePayload = {}) => {
    const roomName = requireString(payload.room);
    if (!roomName || !isQueueSelection(payload.queueType)) {
      socket.emit('error', { message: 'Invalid queue type' });
      return;
    }

    const room = getRoom(roomName);
    let selectedType: QueueType | null = payload.queueType === 'combined' ? null : payload.queueType;
    let entry: QueueEntry | null = null;

    if (payload.queueType === 'combined') {
      const markingTop = room.marking.find((item) => item.status === 'waiting') ?? null;
      const questionTop = room.question.find((item) => item.status === 'waiting') ?? null;

      if (markingTop && questionTop) {
        if (new Date(markingTop.joinedAt) <= new Date(questionTop.joinedAt)) {
          entry = markingTop;
          selectedType = 'marking';
        } else {
          entry = questionTop;
          selectedType = 'question';
        }
      } else if (markingTop) {
        entry = markingTop;
        selectedType = 'marking';
      } else if (questionTop) {
        entry = questionTop;
        selectedType = 'question';
      }
    } else {
      entry = room[payload.queueType].find((item) => item.status === 'waiting') ?? null;
    }

    if (!entry || !selectedType) return;

    entry.status = 'called';
    saveQueues();
    emitToUser(entry.userId, 'being-called', {
      queueType: selectedType,
      message: 'You are called. Please raise your hand.',
    });

    if (selectedType === 'question' && 'followers' in entry) {
      entry.followers.forEach((follower) => {
        emitToUser(follower.userId, 'being-called', {
          queueType: 'question',
          message: 'A question you follow is being answered!',
        });
      });
    }

    broadcastQueues(roomName);
  });

  socket.on('ta-call-specific', (payload: TASpecificPayload = {}) => {
    const roomName = requireString(payload.room);
    const entryId = requireString(payload.entryId);
    if (!roomName || !entryId || !isQueueSelection(payload.queueType)) return;

    const room = getRoom(roomName);
    const { entry, realType } = findEntry(room, payload.queueType, entryId);
    if (!entry || !realType) return;

    entry.status = 'called';
    saveQueues();
    emitToUser(entry.userId, 'being-called', {
      queueType: realType,
      message: 'TA will be with you shortly.',
    });

    if (realType === 'question' && 'followers' in entry) {
      entry.followers.forEach((follower) => {
        emitToUser(follower.userId, 'being-called', {
          queueType: 'question',
          message: 'A question you follow is being answered!',
        });
      });
    }

    broadcastQueues(roomName);
  });

  socket.on('ta-cancel-call', (payload: TASpecificPayload = {}) => {
    const roomName = requireString(payload.room);
    const entryId = requireString(payload.entryId);
    if (!roomName || !entryId || !isQueueSelection(payload.queueType)) return;

    const room = getRoom(roomName);
    const { entry, realType } = findEntry(room, payload.queueType, entryId);
    if (!entry || !realType || entry.status !== 'called') return;

    entry.status = 'waiting';
    saveQueues();
    emitToUser(entry.userId, 'pushed-back', {
      queueType: realType,
      position: getActivePosition(room[realType], entry),
    });
    broadcastQueues(roomName);
  });

  socket.on('ta-start-assisting', (payload: TASpecificPayload = {}) => {
    const roomName = requireString(payload.room);
    const entryId = requireString(payload.entryId);
    if (!roomName || !entryId || !isQueueSelection(payload.queueType)) return;

    const room = getRoom(roomName);
    const { entry, realType } = findEntry(room, payload.queueType, entryId);
    if (!entry || !realType) return;

    entry.status = 'assisting';
    saveQueues();
    emitToUser(entry.userId, 'assisting-started', {
      queueType: realType,
      message: 'The TA has started assisting you.',
    });
    broadcastQueues(roomName);
  });

  socket.on('ta-next', (payload: TAQueuePayload = {}) => {
    const roomName = requireString(payload.room);
    if (!roomName || !isQueueSelection(payload.queueType)) return;

    const room = getRoom(roomName);
    const queueTypes: QueueType[] =
      payload.queueType === 'combined' ? ['marking', 'question'] : [payload.queueType];

    let changed = false;

    queueTypes.forEach((queueType) => {
      const assistingEntries = room[queueType].filter((entry) => entry.status === 'assisting');
      if (assistingEntries.length === 0) return;

      changed = true;
      if (queueType === 'marking') {
        room.marking = room.marking.filter((entry) => entry.status !== 'assisting');
      } else {
        room.question = room.question.filter((entry) => entry.status !== 'assisting');
      }

      assistingEntries.forEach((entry) => {
        if (queueType === 'marking') {
          emitToUser(entry.userId, 'finished-assisting', {
            queueType,
            message: 'Session finished.',
          });
        }
      });

      if (queueType === 'marking') {
        notifyNextStudents(roomName, queueType);
      }
    });

    if (!changed) return;

    saveQueues();
    broadcastQueues(roomName);
  });

  socket.on('ta-remove', (payload: TASpecificPayload = {}) => {
    const roomName = requireString(payload.room);
    const entryId = requireString(payload.entryId);
    if (!roomName || !entryId || !isQueueType(payload.queueType)) return;

    const room = getRoom(roomName);
    const queue = room[payload.queueType];
    const index = queue.findIndex((entry) => entry.id === entryId);
    if (index === -1) return;

    const [removed] = queue.splice(index, 1);
    saveQueues();
    emitToUser(removed.userId, 'removed-from-queue', {
      queueType: payload.queueType,
      message: 'You have been removed.',
    });
    broadcastQueues(roomName);
  });

  socket.on('ta-clear-all', (payload: { room?: string } = {}) => {
    const roomName = requireString(payload.room);
    if (!roomName) return;

    const room = getRoom(roomName);
    room.marking = [];
    room.question = [];
    saveQueues();
    broadcastQueues(roomName);
    io.to(roomName).emit('removed-from-queue', { message: 'Queue reset by TA.' });
  });

  socket.on('ta-delete-room', (payload: { room?: string } = {}) => {
    const roomName = requireString(payload.room);
    if (!roomName || !rooms.has(roomName)) return;

    rooms.delete(roomName);
    saveQueues();
    io.to(roomName).emit('room-deleted', { message: 'This room has been closed by the TA.' });
    io.in(roomName).socketsLeave(roomName);
    console.log(`Room ${roomName} deleted by TA`);
    broadcastRoomsList();
  });

  socket.on('disconnect', () => {
    if (currentUserId) {
      unregisterUserSocket(currentUserId, socket.id);
    }
  });
});

app.get('/api/rooms', (_req: Request, res: Response) => {
  try {
    res.json(buildRoomList());
  } catch (error) {
    console.error('Error in /api/rooms:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/room-status', (req: Request, res: Response) => {
  const room = getQueryString(req.query.room);
  if (!room) {
    res.status(400).json({ error: 'Room required' });
    return;
  }

  if (rooms.has(room)) {
    res.json({ exists: true, hasPassword: Boolean(rooms.get(room)?.password) });
    return;
  }

  res.json({ exists: false, hasPassword: false });
});

app.post('/api/claim-room', (req: Request<unknown, unknown, ClaimRoomBody>, res: Response) => {
  const room = requireString(req.body.room);
  const masterPassword = requireString(req.body.masterPassword);

  if (!room || !masterPassword) {
    res.status(400).json({ success: false, message: 'Room and master password are required' });
    return;
  }

  if (masterPassword !== MASTER_PASSWORD) {
    res.status(401).json({ success: false, message: 'Incorrect Master Password' });
    return;
  }

  const roomData = getRoom(room);
  roomData.password = optionalString(req.body.newPassword);
  saveQueues();
  res.json({ success: true });
});

app.post('/api/room-auth', (req: Request<unknown, unknown, RoomAuthBody>, res: Response) => {
  const room = requireString(req.body.room);
  const password = requireString(req.body.password);
  if (!room || !password) {
    res.status(400).json({ success: false, message: 'Room and password are required' });
    return;
  }

  const roomData = rooms.get(room);
  if (!roomData) {
    res.status(404).json({ success: false, message: 'Room not found' });
    return;
  }

  if (roomData.password && roomData.password === password) {
    res.json({ success: true });
    return;
  }

  res.status(401).json({ success: false, message: 'Incorrect room password' });
});

app.get('/api/user-status', (req: Request, res: Response) => {
  const userId = getQueryString(req.query.userId);
  if (!userId) {
    res.status(400).json({ error: 'userId required' });
    return;
  }

  const existingEntry = findUserInAnyRoom(userId);
  if (!existingEntry) {
    res.json({ inQueue: false });
    return;
  }

  res.json({
    inQueue: true,
    room: existingEntry.room,
    queueType: existingEntry.queueType,
    entryId: existingEntry.entry.id,
    status: existingEntry.entry.status,
  });
});

if (fs.existsSync(DIST_PATH)) {
  console.log('Serving static files from:', DIST_PATH);
  app.use(express.static(DIST_PATH));

  app.get('*', (req: Request, res: Response) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    res.sendFile(path.join(DIST_PATH, 'index.html'));
  });
} else {
  console.log('No dist folder found. Run "npm run build" to generate frontend files.');
  console.log('Expected path:', DIST_PATH);
}

httpServer.listen(PORT, () => {
  console.log(`Queue server running on port ${PORT}`);
  if (fs.existsSync(DIST_PATH)) {
    console.log(`Frontend available at http://localhost:${PORT}`);
  }
});
