import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { hasVendorInquiryLink } from '../lib/vendorInquiries.js';
import { authenticateToken } from '../middleware/auth.js';
import { canAccessTable } from '../lib/access.js';
import { orderedParticipants } from '../lib/conversationHelpers.js';
import { MESSAGABLE_VENUE_MEMBER_STATUSES } from '../lib/venueTableMessageTemplates.js';
const router = Router();
const DIRECT_PREFIX = 'direct:';

async function resolveUserId(id) {
  const profile = await prisma.userProfile.findUnique({ where: { id } }).catch(() => null);
  return profile?.userId || id;
}

async function canAccessChat(chatId, userId, userRole) {
  const chat = await prisma.chat.findUnique({ where: { id: chatId } });
  if (!chat?.relatedTableId) return { allowed: false, chat: null };

  if (chat.relatedTableId.startsWith(DIRECT_PREFIX)) {
    const participants = chat.relatedTableId.slice(DIRECT_PREFIX.length).split(':');
    return { allowed: participants.includes(userId), chat };
  }

  const allowed = await canAccessTable(chat.relatedTableId, userId, userRole);
  return { allowed, chat };
}

function mapMessage(m) {
  const mediaPrefix = '__media__:';
  const isMedia = typeof m.content === 'string' && m.content.startsWith(mediaPrefix);
  const mediaUrl = isMedia ? m.content.slice(mediaPrefix.length) : null;
  return {
    id: m.id,
    chat_id: m.chatId,
    sender_id: m.senderId,
    content: isMedia ? 'Media' : m.content,
    message_type: isMedia ? 'image' : 'text',
    media_url: mediaUrl,
    reactions: {},
    created_date: m.createdAt,
  };
}

async function canDirectMessage(userA, userB) {
  const f = await prisma.friendship.findFirst({
    where: {
      status: 'ACCEPTED',
      OR: [
        { requesterId: userA, receiverId: userB },
        { requesterId: userB, receiverId: userA },
      ],
    },
    select: { id: true },
  });
  if (f) return true;
  return hasVendorInquiryLink(userA, userB);
}

function otherParticipantId(conv, me) {
  return conv.participantAId === me ? conv.participantBId : conv.participantAId;
}

function conversationHiddenForUser(conv, me) {
  if (conv.participantAId === me) return Boolean(conv.participantAHiddenAt);
  if (conv.participantBId === me) return Boolean(conv.participantBHiddenAt);
  return false;
}

async function hideConversationForUser(conversationId, me) {
  const c = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!c || (c.participantAId !== me && c.participantBId !== me)) return null;
  const data =
    c.participantAId === me
      ? { participantAHiddenAt: new Date() }
      : { participantBHiddenAt: new Date() };
  const updated = await prisma.conversation.update({ where: { id: c.id }, data });
  if (updated.participantAHiddenAt && updated.participantBHiddenAt) {
    await prisma.directMessage.deleteMany({ where: { conversationId: c.id } });
    await prisma.conversation.delete({ where: { id: c.id } });
    return { deleted: true };
  }
  return { hidden: true };
}

/** ── Direct message conversations (friends) ─────────────────────────── */

router.post('/conversations/find-or-create', authenticateToken, async (req, res, next) => {
  try {
    const parsed = z.object({ participantId: z.string().min(1) }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
    const participantId = parsed.data.participantId;
    const me = req.userId;
    if (participantId === me) return res.status(400).json({ error: 'Invalid participant' });

    const friends = await canDirectMessage(me, participantId);
    if (!friends) {
      return res.status(403).json({ error: 'You can only message friends, or vendors linked to a hire request' });
    }

    const targetProfile = await prisma.userProfile.findUnique({
      where: { userId: participantId },
      select: { privacySettings: true },
    });
    const allowMessages =
      !targetProfile?.privacySettings ||
      typeof targetProfile.privacySettings !== 'object' ||
      targetProfile.privacySettings.allowMessages !== false;
    if (!allowMessages) {
      return res.status(403).json({ error: 'This user is not accepting new messages' });
    }

    const parts = orderedParticipants(me, participantId);
    let conv = await prisma.conversation.findUnique({
      where: {
        participantAId_participantBId: {
          participantAId: parts.participantAId,
          participantBId: parts.participantBId,
        },
      },
    });
    if (!conv) {
      conv = await prisma.conversation.create({
        data: {
          participantAId: parts.participantAId,
          participantBId: parts.participantBId,
        },
      });
    }
    res.json({
      id: conv.id,
      participantAId: conv.participantAId,
      participantBId: conv.participantBId,
      createdAt: conv.createdAt,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/conversations', authenticateToken, async (req, res, next) => {
  try {
    const me = req.userId;
    const convs = await prisma.conversation.findMany({
      where: {
        OR: [{ participantAId: me }, { participantBId: me }],
      },
      orderBy: { lastMessageAt: 'desc' },
      take: 100,
    });

    const out = [];
    for (const c of convs) {
      if (conversationHiddenForUser(c, me)) continue;
      const otherId = otherParticipantId(c, me);
      const ok = await canDirectMessage(me, otherId);
      if (!ok) continue;

      const other = await prisma.user.findUnique({
        where: { id: otherId },
        select: {
          id: true,
          username: true,
          fullName: true,
          userProfile: { select: { avatarUrl: true } },
        },
      });
      if (!other) continue;

      const last = await prisma.directMessage.findFirst({
        where: { conversationId: c.id },
        orderBy: { sentAt: 'desc' },
      });

      const unreadCount = await prisma.directMessage.count({
        where: {
          conversationId: c.id,
          readAt: null,
          senderUserId: { not: me },
        },
      });

      out.push({
        conversationId: c.id,
        participant: {
          id: other.id,
          username: other.username || '',
          fullName: other.fullName || '',
          avatarUrl: other.userProfile?.avatarUrl || null,
        },
        lastMessage: last
          ? { body: last.body, sentAt: last.sentAt, senderUserId: last.senderUserId }
          : null,
        unreadCount,
      });
    }

    out.sort((a, b) => {
      const ta = a.lastMessage?.sentAt ? new Date(a.lastMessage.sentAt).getTime() : 0;
      const tb = b.lastMessage?.sentAt ? new Date(b.lastMessage.sentAt).getTime() : 0;
      return tb - ta;
    });

    res.json(out);
  } catch (err) {
    next(err);
  }
});

/** Total unread across DMs + group chats (for Messages nav badge / sound) */
router.get('/unread-total', authenticateToken, async (req, res, next) => {
  try {
    const me = req.userId;
    const convs = await prisma.conversation.findMany({
      where: { OR: [{ participantAId: me }, { participantBId: me }] },
    });
    let dmUnread = 0;
    for (const c of convs) {
      const otherId = otherParticipantId(c, me);
      if (!(await canDirectMessage(me, otherId))) continue;
      dmUnread += await prisma.directMessage.count({
        where: {
          conversationId: c.id,
          readAt: null,
          senderUserId: { not: me },
        },
      });
    }

    const memberships = await prisma.groupChatMember.findMany({ where: { userId: me } });
    let groupUnread = 0;
    for (const m of memberships) {
      const last = await prisma.groupChatMessage.findFirst({
        where: { groupChatId: m.groupChatId },
        orderBy: { sentAt: 'desc' },
      });
      if (!last) continue;
      const since = m.lastReadAt || new Date(0);
      groupUnread += await prisma.groupChatMessage.count({
        where: {
          groupChatId: m.groupChatId,
          senderUserId: { not: me },
          sentAt: { gt: since },
        },
      });
    }

    const tableThreadUnread = await prisma.venueTableMessage.count({
      where: {
        readAt: null,
        senderUserId: { not: me },
        thread: {
          member: {
            userId: me,
            status: { in: MESSAGABLE_VENUE_MEMBER_STATUSES },
          },
        },
      },
    });

    res.json({ total: dmUnread + groupUnread + tableThreadUnread });
  } catch (err) {
    next(err);
  }
});

router.get('/conversations/:conversationId/unread', authenticateToken, async (req, res, next) => {
  try {
    const me = req.userId;
    const c = await prisma.conversation.findUnique({ where: { id: req.params.conversationId } });
    if (!c || (c.participantAId !== me && c.participantBId !== me)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const unreadCount = await prisma.directMessage.count({
      where: {
        conversationId: c.id,
        readAt: null,
        senderUserId: { not: me },
      },
    });
    res.json({ unreadCount });
  } catch (err) {
    next(err);
  }
});

router.get('/conversations/:conversationId', authenticateToken, async (req, res, next) => {
  try {
    const me = req.userId;
    const c = await prisma.conversation.findUnique({ where: { id: req.params.conversationId } });
    if (!c || (c.participantAId !== me && c.participantBId !== me)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const otherId = otherParticipantId(c, me);
    const ok = await canDirectMessage(me, otherId);
    if (!ok) return res.status(403).json({ message: 'You can only message friends.' });

    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 50);
    const beforeMessageId = req.query.beforeMessageId ? String(req.query.beforeMessageId) : null;

    let beforeSentAt = null;
    if (beforeMessageId) {
      const bm = await prisma.directMessage.findFirst({
        where: { id: beforeMessageId, conversationId: c.id },
      });
      if (bm) beforeSentAt = bm.sentAt;
    }

    const where = {
      conversationId: c.id,
      ...(beforeSentAt ? { sentAt: { lt: beforeSentAt } } : {}),
    };

    const page = await prisma.directMessage.findMany({
      where,
      orderBy: { sentAt: 'desc' },
      take: limit,
      include: {
        replyTo: {
          select: {
            id: true,
            body: true,
            sentAt: true,
            senderUserId: true,
          },
        },
      },
    });
    const chronological = page.reverse();

    await prisma.directMessage.updateMany({
      where: {
        conversationId: c.id,
        readAt: null,
        senderUserId: { not: me },
      },
      data: { readAt: new Date() },
    });

    res.json(
      chronological.map((m) => ({
        id: m.id,
        conversationId: m.conversationId,
        senderUserId: m.senderUserId,
        body: m.body,
        readAt: m.readAt,
        sentAt: m.sentAt,
        replyTo: m.replyTo
          ? {
              id: m.replyTo.id,
              body: m.replyTo.body,
              sentAt: m.replyTo.sentAt,
            }
          : null,
      })),
    );
  } catch (err) {
    next(err);
  }
});

router.delete('/conversations/:conversationId', authenticateToken, async (req, res, next) => {
  try {
    const result = await hideConversationForUser(req.params.conversationId, req.userId);
    if (!result) return res.status(403).json({ error: 'Forbidden' });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/conversations/:conversationId', authenticateToken, async (req, res, next) => {
  try {
    const me = req.userId;
    const schema = z.object({
      body: z.string().trim().min(1).max(1000),
      replyToMessageId: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid message' });

    const c = await prisma.conversation.findUnique({ where: { id: req.params.conversationId } });
    if (!c || (c.participantAId !== me && c.participantBId !== me)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (c.participantAHiddenAt || c.participantBHiddenAt) {
      await prisma.conversation.update({
        where: { id: c.id },
        data: { participantAHiddenAt: null, participantBHiddenAt: null },
      });
    }

    const otherId = otherParticipantId(c, me);
    const friends = await canDirectMessage(me, otherId);
    if (!friends) {
      return res.status(403).json({
        message: 'You can only message friends. Send a friend request first.',
      });
    }

    if (parsed.data.replyToMessageId) {
      const parent = await prisma.directMessage.findFirst({
        where: { id: parsed.data.replyToMessageId, conversationId: c.id },
      });
      if (!parent) return res.status(400).json({ error: 'Reply target not found' });
    }

    const created = await prisma.$transaction(async (tx) => {
      const msg = await tx.directMessage.create({
        data: {
          conversationId: c.id,
          senderUserId: me,
          body: parsed.data.body,
          replyToMessageId: parsed.data.replyToMessageId || null,
        },
      });
      await tx.conversation.update({
        where: { id: c.id },
        data: { lastMessageAt: new Date() },
      });
      return msg;
    });

    res.status(201).json({
      id: created.id,
      conversationId: created.conversationId,
      senderUserId: created.senderUserId,
      body: created.body,
      readAt: created.readAt,
      sentAt: created.sentAt,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/filter', authenticateToken, async (req, res, next) => {
  try {
    const chatId = req.query.chat_id;
    if (!chatId) return res.status(400).json({ error: 'chat_id required' });

    const { allowed } = await canAccessChat(String(chatId), req.userId, req.userRole);
    if (!allowed) return res.status(403).json({ error: 'Forbidden' });

    const sort = String(req.query.sort || 'created_date');
    const desc = sort === '-created_date';
    const orderBy = { createdAt: desc ? 'desc' : 'asc' };
    const take = Math.min(parseInt(req.query.limit, 10) || 100, 100);
    const beforeMessageId = typeof req.query.before_message_id === 'string'
      ? req.query.before_message_id.trim()
      : '';

    let cursorClause = {};
    if (beforeMessageId) {
      const anchor = await prisma.message.findFirst({
        where: { id: beforeMessageId, chatId: String(chatId) },
        select: { createdAt: true },
      });
      if (anchor) {
        cursorClause = desc
          ? { createdAt: { lt: anchor.createdAt } }
          : { createdAt: { gt: anchor.createdAt } };
      }
    }

    const rows = await prisma.message.findMany({
      where: { chatId: String(chatId), ...cursorClause },
      orderBy,
      take,
    });
    res.json(rows.map(mapMessage));
  } catch (err) {
    next(err);
  }
});

router.post('/', authenticateToken, async (req, res, next) => {
  try {
    const schema = z.object({
      chat_id: z.string().uuid(),
      sender_id: z.string().optional(),
      content: z.string().trim().min(1).max(5000).optional(),
      media_url: z.string().url().optional().nullable(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });

    const d = parsed.data;
    const { allowed, chat } = await canAccessChat(d.chat_id, req.userId, req.userRole);
    if (!allowed || !chat) return res.status(403).json({ error: 'Forbidden' });

    const senderId = d.sender_id ? await resolveUserId(d.sender_id) : req.userId;
    if (senderId !== req.userId) return res.status(403).json({ error: 'Forbidden' });

    const content = d.media_url ? `__media__:${d.media_url}` : (d.content || '');
    if (!content.trim()) return res.status(400).json({ error: 'Content required' });

    const created = await prisma.message.create({
      data: {
        chatId: d.chat_id,
        senderId,
        content,
      },
    });

    await prisma.chat.update({
      where: { id: d.chat_id },
      data: { lastMessageAt: new Date() },
    }).catch(() => {});

    res.status(201).json(mapMessage(created));
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', authenticateToken, async (req, res, next) => {
  try {
    const msg = await prisma.message.findUnique({ where: { id: req.params.id } });
    if (!msg) return res.status(404).json({ error: 'Not found' });

    const { allowed } = await canAccessChat(msg.chatId, req.userId, req.userRole);
    if (!allowed) return res.status(403).json({ error: 'Forbidden' });
    if (msg.senderId !== req.userId) return res.status(403).json({ error: 'Only sender can edit message' });

    const schema = z.object({
      content: z.string().trim().min(1).max(5000).optional(),
      reactions: z.any().optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });

    if (!parsed.data.content) return res.json(mapMessage(msg));
    const updated = await prisma.message.update({
      where: { id: msg.id },
      data: { content: parsed.data.content },
    });
    res.json(mapMessage(updated));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', authenticateToken, async (req, res, next) => {
  try {
    const msg = await prisma.message.findUnique({ where: { id: req.params.id } });
    if (!msg) return res.status(404).json({ error: 'Not found' });

    const { allowed } = await canAccessChat(msg.chatId, req.userId, req.userRole);
    if (!allowed) return res.status(403).json({ error: 'Forbidden' });
    if (msg.senderId !== req.userId) return res.status(403).json({ error: 'Only sender can delete message' });

    await prisma.message.delete({ where: { id: msg.id } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
