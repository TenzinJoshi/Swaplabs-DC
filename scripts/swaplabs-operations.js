(() => {
  'use strict';

  const pageRoot = document.querySelector('[data-operations-page]');
  const adminRoot = document.querySelector('[data-auth-page="admin"]');
  if (!pageRoot && !adminRoot) return;

  const state = {
    csrf: '',
    user: null,
    inbox: null,
    activeConversationId: '',
    activeConversation: null,
    activeMessages: [],
    inboxPoll: null,
    inboxRequest: null,
    inboxContactsRequest: null,
    chatPoll: null,
    conversationRequests: new Map(),
    assistantReminderPoll: null,
    typingTimer: null,
    typingSentAt: 0,
    conversationMenuId: '',
    editingGroupId: '',
    groupSelectedIds: new Set(),
    groupAdminIds: new Set(),
    sharedContent: null,
    sharedContentTab: 'media',
    calendar: null,
    // Keep the shared agenda useful from either calendar tab. Users can still
    // narrow it to upcoming, completed, cancelled, or awaiting confirmation.
    calendarFilter: 'all',
    calendarView: 'week',
    calendarTab: 'calendar',
    calendarCursor: new Date(),
    calendarPoll: null,
    calendarDrag: null,
    calendarDragJustFinished: 0,
    liveSessions: null,
    liveSessionFilter: 'upcoming',
    liveSessionSearch: '',
    liveSessionPoll: null,
    credits: null,
    operations: null,
    adminTab: 'reports'
  };
  const writeMethods = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const {escapeHtml, initials, safeAvatarUrl} = window.RelayComponents;
  const escapeAttr = escapeHtml;
  const formatDate = value => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? String(value || '') : new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(parsed);
  };
  const formatShortTime = value => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '' : new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit'
    }).format(parsed);
  };
  const formatDay = value => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '' : new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric'
    }).format(parsed);
  };
  const relativeTime = value => {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '';
    const seconds = Math.round((parsed.getTime() - Date.now()) / 1000);
    const formatter = new Intl.RelativeTimeFormat(undefined, {
      numeric: 'auto'
    });
    if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second');
    const minutes = Math.round(seconds / 60);
    if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 24) return formatter.format(hours, 'hour');
    return formatter.format(Math.round(hours / 24), 'day');
  };
  const safeAvatar = safeAvatarUrl;
  const safeGroupLogo = conversation => {
    const value = String(conversation?.group_logo_url || '');
    return /^\/uploads\/group_[A-Za-z0-9_-]+\.(jpg|png|webp)$/.test(value) ? value : '';
  };
  const avatarHtml = (member, bot = false) => {
    const source = safeAvatar(member);
    const color = ['blue', 'pink', 'purple', 'indigo', 'green', 'orange'].includes(member?.profile_color || member?.profile
      ?.profile_color) ? (member?.profile_color || member?.profile?.profile_color) : 'indigo';
    return `<span class="ops-avatar ${bot ? 'bot' : escapeAttr(color)}">${source ? `<img src="${escapeAttr(source)}" alt="${escapeAttr(member?.display_name || member?.profile?.display_name || 'Member')} profile photo">` : bot ? '<i class="bx bx-bot"></i>' : escapeHtml(initials(member))}</span>`;
  };
  const meetingAvatarHtml = () =>
    '<span class="ops-avatar meeting"><i class="bx bx-calendar-event"></i></span>';
  const groupAvatarHtml = conversation => {
    const source = safeGroupLogo(conversation);
    return `<span class="ops-avatar group">${source ? `<img src="${escapeAttr(source)}" alt="${escapeAttr(conversation?.title || 'Group')} logo">` : '<i class="bx bx-group"></i>'}</span>`;
  };

  const AI_CONVERSATION_ID = 'relayskills-ai-assistant';
  const AI_CHAT_STORAGE_KEY = 'relayskills-ai-chat-v1';
  const AI_REMINDER_STORAGE_KEY = 'relayskills-ai-reminders-v1';
  let assistantHistoryReady = false;
  let assistantHistorySyncTimer = 0;
  const assistantProfile = () => ({
    display_name: 'SwapBot',
    username: 'relayskills-ai',
    profile_color: 'purple'
  });
  const isAssistantConversation = conversation => Boolean(conversation && (
    conversation.id === AI_CONVERSATION_ID || conversation.kind === 'assistant' || conversation.kind === 'bot'
  ));
  const assistantScope = () => state.user?.id || 'anonymous';
  const readScopedStore = key => {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_error) {
      return {};
    }
  };
  const writeScopedStore = (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_error) {
      return false;
    }
  };
  const assistantWelcomeMessage = () => ({
    id: 'relayskills-ai-welcome',
    conversation_id: AI_CONVERSATION_ID,
    sender_id: AI_CONVERSATION_ID,
    sender_kind: 'bot',
    sender: assistantProfile(),
    body: 'Hi — I’m SwapBot. Ask about any page or feature, say “remind me to…” to save a reminder, or ask me to help you find your next exchange.',
    metadata: {
      article_title: 'Your SwapBot guide',
      confidence: 1,
      links: [{href: 'help-center.html', label: 'Open Help Center', icon: 'bx-help-circle'}],
      followups: ['How does matching work?', 'How do time credits work?', 'Remind me to review my profile tomorrow at 7pm']
    },
    read_by: [state.user?.id].filter(Boolean),
    created_at: new Date().toISOString()
  });
  const readAssistantMessages = () => {
    const store = readScopedStore(AI_CHAT_STORAGE_KEY);
    const scope = assistantScope();
    if (!Object.prototype.hasOwnProperty.call(store, scope)) return [assistantWelcomeMessage()];
    return Array.isArray(store[scope]) ? store[scope] : [];
  };
  const scheduleAssistantHistorySync = () => {
    if (!state.user || !assistantHistoryReady) return;
    window.clearTimeout(assistantHistorySyncTimer);
    assistantHistorySyncTimer = window.setTimeout(() => {
      api('/api/swapbot/history', {
        method: 'PUT',
        body: {
          messages: readAssistantMessages(),
          reminders: readAssistantReminders()
        }
      }).catch(() => {
        // The local cache remains available if the account API is temporarily unavailable.
      });
    }, 250);
  };
  const writeAssistantMessages = messages => {
    const store = readScopedStore(AI_CHAT_STORAGE_KEY);
    store[assistantScope()] = messages.slice(-200);
    writeScopedStore(AI_CHAT_STORAGE_KEY, store);
    scheduleAssistantHistorySync();
  };
  const readAssistantReminders = () => {
    const store = readScopedStore(AI_REMINDER_STORAGE_KEY);
    return Array.isArray(store[assistantScope()]) ? store[assistantScope()] : [];
  };
  const writeAssistantReminders = reminders => {
    const store = readScopedStore(AI_REMINDER_STORAGE_KEY);
    store[assistantScope()] = reminders.slice(-100);
    writeScopedStore(AI_REMINDER_STORAGE_KEY, store);
    scheduleAssistantHistorySync();
  };
  const loadAssistantHistory = async () => {
    if (!state.user) return;
    const scope = assistantScope();
    const localMessages = readAssistantMessages();
    const localReminders = readAssistantReminders();
    try {
      const result = await api('/api/swapbot/history');
      const messageStore = readScopedStore(AI_CHAT_STORAGE_KEY);
      const reminderStore = readScopedStore(AI_REMINDER_STORAGE_KEY);
      if (result.exists) {
        messageStore[scope] = Array.isArray(result.messages) ? result.messages : [];
        reminderStore[scope] = Array.isArray(result.reminders) ? result.reminders : [];
        writeScopedStore(AI_CHAT_STORAGE_KEY, messageStore);
        writeScopedStore(AI_REMINDER_STORAGE_KEY, reminderStore);
      } else if (localMessages.length > 1 || localReminders.length) {
        // Migrate history created before account storage was added, then use the
        // server record for every subsequent visit and device.
        messageStore[scope] = localMessages;
        reminderStore[scope] = localReminders;
        writeScopedStore(AI_CHAT_STORAGE_KEY, messageStore);
        writeScopedStore(AI_REMINDER_STORAGE_KEY, reminderStore);
        await api('/api/swapbot/history', {
          method: 'PUT',
          body: {messages: localMessages, reminders: localReminders}
        });
      }
    } catch (_error) {
      // Keep the browser cache usable while a transient network problem clears.
    } finally {
      assistantHistoryReady = true;
    }
  };
  const assistantConversation = (source = {}) => {
    const messages = readAssistantMessages();
    const latest = messages.at(-1);
    const createdAt = source.created_at || messages[0]?.created_at || new Date().toISOString();
    return {
      ...source,
      id: AI_CONVERSATION_ID,
      kind: 'assistant',
      title: 'SwapBot',
      subtitle: 'AI assistant · website guide',
      members: [],
      latest_message: latest ? {body: latest.body, created_at: latest.created_at, sender_id: latest.sender_id} : null,
      unread_count: 0,
      muted: false,
      created_at: createdAt,
      updated_at: latest?.created_at || source.updated_at || createdAt
    };
  };
  const assistantDateLabel = value => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? String(value || '') : new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(parsed);
  };
  const assistantLink = (href, label, icon = 'bx-right-arrow-alt') => ({href, label, icon});
  const assistantTimezone = () => state.user?.profile?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const assistantReminderEvent = reminder => {
    const startsAt = new Date(reminder.due_at);
    const endsAt = new Date(startsAt.getTime() + 30 * 60 * 1000);
    return {
      title: `Reminder: ${reminder.task}`,
      description: 'Saved from the private SwapBot chat.',
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      timezone: assistantTimezone(),
      participant_ids: [],
      location: '',
      meeting_url: '',
      reminders_minutes: [0],
      recurrence: 'none',
      recurrence_count: 1,
      all_day: false
    };
  };
  const saveAssistantReminderToCalendar = async reminder => {
    if (reminder.calendar_event_id) return reminder.calendar_event_id;
    const result = await api('/api/calendar/events', {
      method: 'POST',
      body: assistantReminderEvent(reminder)
    });
    const eventId = result.event?.id || '';
    if (!eventId) throw new Error('Calendar did not return the saved event.');
    reminder.calendar_event_id = eventId;
    reminder.calendar_saved_at = new Date().toISOString();
    return eventId;
  };
  const syncAssistantRemindersToCalendar = async () => {
    const reminders = readAssistantReminders();
    let changed = false;
    for (const reminder of reminders) {
      if (reminder.completed || reminder.dismissed || reminder.calendar_event_id) continue;
      try {
        await saveAssistantReminderToCalendar(reminder);
        changed = true;
      } catch (_error) {
        // Existing browser-only reminders are left intact if Calendar is
        // temporarily unavailable; a later Inbox refresh will retry them.
      }
    }
    if (changed) writeAssistantReminders(reminders);
    return changed;
  };
  const parseReminderRequest = text => {
    if (!/\b(?:remind\s+me|remember\s+to|(?:set|create|add)\s+(?:a\s+)?reminder|reminder\s+(?:to|for))\b/i.test(text)) return null;
    const original = String(text || '').trim();
    const now = new Date();
    const relative = original.match(/\bin\s+(\d+)\s+(minute|minutes|hour|hours|day|days)\b/i);
    const dayWord = original.match(/\b(today|tomorrow|tonight)\b/i);
    const timeMatch = original.match(/\b(?:at|@)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
    let due = new Date(now);
    if (relative) {
      const amount = Number(relative[1]);
      const unit = relative[2].toLowerCase();
      due = new Date(now.getTime() + amount * (unit.startsWith('minute') ? 60000 : unit.startsWith('hour') ? 3600000 : 86400000));
    } else if (dayWord) {
      if (dayWord[1].toLowerCase() !== 'today') due.setDate(due.getDate() + 1);
      due.setHours(dayWord[1].toLowerCase() === 'tonight' ? 20 : 9, 0, 0, 0);
    } else {
      due = new Date(now.getTime() + 3600000);
    }
    if (timeMatch) {
      let hours = Number(timeMatch[1]);
      const minutes = Number(timeMatch[2] || 0);
      const meridiem = String(timeMatch[3] || '').toLowerCase();
      if (meridiem === 'pm' && hours < 12) hours += 12;
      if (meridiem === 'am' && hours === 12) hours = 0;
      due.setHours(hours, minutes, 0, 0);
      if (due <= now) due.setDate(due.getDate() + 1);
    }
    if (dayWord && dayWord[1].toLowerCase() === 'today' && !timeMatch && due <= now) due.setDate(due.getDate() + 1);
    let task = original
      .replace(/^\s*(?:please\s+)?(?:set|create|add)\s+(?:a\s+)?reminder\s*/i, '')
      .replace(/^\s*(?:please\s+)?(?:remind|remember)\s+(?:me\s+)?(?:to\s+)?/i, '')
      .replace(/^\s*(?:please\s+)?reminder\s*/i, '')
      .replace(/^\s*(?:for|to|me\s+to)\s+/i, '')
      .replace(relative?.[0] || '', '')
      .replace(dayWord?.[0] || '', '')
      .replace(timeMatch?.[0] || '', '')
      .replace(/\s+/g, ' ')
      .replace(/\s+(?:at|on|for)\s*$/i, '')
      .replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '')
      .trim();
    if (!task || /^(?:me|a|the)$/i.test(task)) task = 'check in on your next SwapLabs step';
    return {task, dueAt: due.toISOString()};
  };
  const makeAssistantReply = async text => {
    const clean = String(text || '').trim();
    const normalized = clean.toLowerCase();
    if (/\b(?:show|list|what are|any)\b.*\breminders?\b|\breminders?\b.*\b(?:show|list|upcoming)\b/i.test(clean)) {
      const reminders = readAssistantReminders().filter(item => !item.completed && !item.dismissed);
      if (!reminders.length) return {
        body: 'You do not have any active reminders yet. Try: “Remind me to practice guitar tomorrow at 7pm.”',
        metadata: {article_title: 'Reminder center', followups: ['Remind me to review my profile tomorrow at 7pm']}
      };
      return {
        body: `You have ${reminders.length} active reminder${reminders.length === 1 ? '' : 's'}:\n${reminders.map((item, index) => `${index + 1}. ${item.task} — ${assistantDateLabel(item.due_at)}`).join('\n')}`,
        metadata: {article_title: 'Your reminders', links: [assistantLink('calendar.html', 'Open Calendar', 'bx-calendar')], followups: ['Remind me to prepare for my next exchange tomorrow at 6pm']}
      };
    }
    if (/\b(?:cancel|delete|remove|dismiss)\b.*\breminder\b/i.test(clean)) {
      const reminders = readAssistantReminders().filter(item => !item.completed && !item.dismissed);
      const target = reminders[0];
      if (!target) return {body: 'There are no active reminders to cancel.', metadata: {article_title: 'Reminder center'}};
      if (target.calendar_event_id) {
        try {
          await api(`/api/calendar/events/${encodeURIComponent(target.calendar_event_id)}`, {
            method: 'PATCH',
            body: {status: 'cancelled'}
          });
        } catch (_error) {
          return {body: 'I could not cancel the linked Calendar event yet. Please open Calendar and try again.', metadata: {article_title: 'Calendar update needed', links: [assistantLink(`calendar.html?event=${encodeURIComponent(target.calendar_event_id)}`, 'Open Calendar', 'bx-calendar')]}};
        }
      }
      target.dismissed = true;
      writeAssistantReminders(reminders);
      return {body: `Done — I cancelled “${target.task}” in your reminders and Calendar.`, metadata: {article_title: 'Reminder cancelled', links: [assistantLink('calendar.html', 'Open Calendar', 'bx-calendar')], followups: ['Show my reminders']}};
    }
    const reminder = parseReminderRequest(clean);
    if (reminder) {
      const reminders = readAssistantReminders();
      const created = {id: `rem_${Date.now().toString(36)}`, task: reminder.task, due_at: reminder.dueAt, created_at: new Date().toISOString(), completed: false, dismissed: false};
      let calendarEventId = '';
      try {
        calendarEventId = await saveAssistantReminderToCalendar(created);
      } catch (error) {
        return {
          body: `I could not save that reminder to Calendar, so I have not claimed it was done. ${error.message} Open Calendar to check your account, then try again.`,
          metadata: {article_title: 'Calendar save failed', links: [assistantLink('calendar.html', 'Open Calendar', 'bx-calendar')], followups: ['How do I schedule a session?']}
        };
      }
      reminders.push(created);
      writeAssistantReminders(reminders);
      return {
        body: `Done — I added “${created.task}” to your SwapLabs Calendar for ${assistantDateLabel(created.due_at)}. It is also kept here in your private AI reminders.`,
        metadata: {article_title: 'Reminder saved to Calendar', links: [assistantLink(`calendar.html?event=${encodeURIComponent(calendarEventId)}`, 'Open saved event', 'bx-calendar-plus'), assistantLink('calendar.html', 'Open Calendar', 'bx-calendar')], followups: ['Show my reminders', 'How do I schedule a session?']}
      };
    }
    if (/\b(?:who are you|what can you do|how can you help|ai chatbot|assistant)\b/i.test(clean)) return {
      body: 'I’m SwapBot, your private in-app guide. I can explain website features, point you to the right page, search the member directory, help with matching and safety, and save personal reminders from natural language.',
      metadata: {article_title: 'About SwapBot', links: [assistantLink('help-center.html', 'Open Help Center', 'bx-help-circle'), assistantLink('talent-directory.html', 'Find members', 'bx-user-find')], followups: ['How does matching work?', 'Remind me to update my profile tomorrow at 7pm']}
    };
    if (/\b(?:my profile|my account|am i logged|logged in|session)\b/i.test(normalized)) return {
      body: `You are signed in as ${state.user?.profile?.display_name || state.user?.username || 'this member'}. Your private account tools are available from the shared navigation, including Dashboard, Calendar, Chats, and Profile.`,
      metadata: {article_title: 'Your account', links: [assistantLink('profile.html', 'Open Profile', 'bx-user'), assistantLink('dashboard.html', 'Open Dashboard', 'bx-grid-alt')], followups: ['How do I update my privacy settings?', 'Show my reminders']}
    };
    const result = await (window.SwaplabsAssistant?.contextualLookup?.(clean, {
      page: 'notifications.html',
      user: state.user,
      reminders: readAssistantReminders(),
      messages: readAssistantMessages().slice(-12)
    }) || window.SwaplabsAssistant?.lookup?.(clean)) || {
      title: 'SwapLabs guide',
      page: 'help-center.html',
      answer: 'I can help with matching, profiles, the member directory, messaging, Calendar, workshops, Media, time credits, safety, and account support. Try asking about one of those directly.'
    };
    return {
      body: result.answer,
      metadata: {article_title: result.title || 'SwapLabs guide', confidence: .92, links: result.page ? [assistantLink(result.page, `Open ${result.title || 'related page'}`)] : [], followups: ['How does matching work?', 'How do time credits work?', 'Show my reminders']}
    };
  };
  const checkAssistantReminders = () => {
    if (!state.user || !isAssistantConversation(state.activeConversation?.conversation)) return;
    const nowMs = Date.now();
    const reminders = readAssistantReminders();
    let changed = false;
    reminders.forEach(item => {
      if (item.completed || item.dismissed || item.notified_at || new Date(item.due_at).getTime() > nowMs) return;
      item.notified_at = new Date().toISOString();
      changed = true;
      const messages = readAssistantMessages();
      messages.push({id: `ai_msg_${Date.now().toString(36)}`, conversation_id: AI_CONVERSATION_ID, sender_id: AI_CONVERSATION_ID, sender_kind: 'bot', sender: assistantProfile(), body: `Reminder: ${item.task}`, metadata: {article_title: 'Reminder due', links: [assistantLink('calendar.html', 'Open Calendar', 'bx-calendar')]}, created_at: new Date().toISOString()});
      writeAssistantMessages(messages);
    });
    if (changed) loadConversation(AI_CONVERSATION_ID, {quiet: true, scroll: true});
    if (changed) writeAssistantReminders(reminders);
  };

  async function api(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    if (writeMethods.has(method) && !state.csrf) {
      const tokenResponse = await fetch('/api/auth/csrf', {
        credentials: 'same-origin',
        cache: 'no-store',
        mode: 'same-origin'
      });
      if (!tokenResponse.ok) throw new Error('Could not establish a secure session.');
      state.csrf = (await tokenResponse.json()).csrf_token;
    }
    const headers = {
      ...(options.headers || {})
    };
    if (writeMethods.has(method)) headers['X-CSRF-Token'] = state.csrf;
    if (options.body && typeof options.body !== 'string' && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    let response;
    try {
      response = await fetch(path, {
        ...options,
        method,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        mode: 'same-origin',
        signal: controller.signal
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error('The conversation service took too long to respond. Please refresh and try again.');
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
    let payload = {};
    try {
      payload = await response.json();
    } catch (_error) {
      payload = {
        error: 'The server returned an unreadable response.'
      };
    }
    if (!response.ok) {
      const error = new Error(payload.error || 'Something went wrong.');
      error.status = response.status;
      throw error;
    }
    if (payload.moderation?.status === 'pending') {
      const error = new Error(payload.message || 'Your submission is pending administrator review and is hidden from the platform.');
      error.status = response.status;
      error.code = 'pending_moderation';
      throw error;
    }
    if (payload.csrf_token) state.csrf = payload.csrf_token;
    return payload;
  }

  function toast(message, type = 'success') {
    if (type === 'error' && /pending (?:administrator )?review/i.test(String(message || ''))) type = 'info';
    let element = $('.platform-toast.ops-toast');
    if (!element) {
      element = document.createElement('div');
      element.className = 'platform-toast ops-toast';
      document.body.appendChild(element);
    }
    element.className = `platform-toast ops-toast ${type}`;
    const actionLink = window.SwapLabsNotice?.actionLink(message, type) || '';
    element.classList.toggle('has-action-link', Boolean(actionLink));
    element.innerHTML =
      `<i class="bx ${type === 'error' ? 'bx-error-circle' : 'bx-check-circle'}"></i><div class="toast-copy"><span>${escapeHtml(message)}</span>${actionLink}</div>`;
    requestAnimationFrame(() => element.classList.add('show'));
    clearTimeout(element.hideTimer);
    element.hideTimer = setTimeout(() => element.classList.remove('show'), 3800);
  }

  function meetingInviteUrl(token) {
    const link = new URL('video-room.html', window.location.href);
    link.search = `?invite=${encodeURIComponent(token)}`;
    return link.toString();
  }

  async function copyMeetingInvite(token) {
    const link = meetingInviteUrl(token);
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(link);
      else {
        const input = document.createElement('input');
        input.value = link;
        input.setAttribute('readonly', '');
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        input.remove();
      }
      toast('Meeting invite link copied. Anyone with it can request to join.');
    } catch (_error) {
      toast('Could not copy the meeting invite link.', 'error');
    }
  }

  function setStatus(form, message, type = 'error') {
    const host = $('[data-ops-status]', form);
    if (!host) return;
    if (type === 'error' && /pending (?:administrator )?review/i.test(String(message || ''))) type = 'info';
    host.textContent = message;
    host.className = `ops-form-status show ${type}`;
  }

  function clearStatus(form) {
    const host = $('[data-ops-status]', form);
    if (!host) return;
    host.textContent = '';
    host.className = 'ops-form-status';
  }

  function setButtonLoading(button, active, label = 'Saving') {
    if (!button) return;
    if (active) {
      button.dataset.original = button.innerHTML;
      button.disabled = true;
      button.innerHTML = `<i class="bx bx-loader-alt bx-spin"></i> ${escapeHtml(label)}`;
    } else {
      button.disabled = false;
      if (button.dataset.original) button.innerHTML = button.dataset.original;
    }
  }

  function showAuthenticatedApp(appSelector) {
    $('#opsLoading')?.setAttribute('hidden', '');
    $('#opsAuthGate')?.setAttribute('hidden', '');
    $(appSelector)?.removeAttribute('hidden');
  }

  function showAuthGate() {
    $('#opsLoading')?.setAttribute('hidden', '');
    $('#opsAuthGate')?.removeAttribute('hidden');
  }

  /* Inbox */
  function conversationPreview(conversation) {
    const latest = conversation.latest_message;
    if (!latest) return 'No messages yet';
    if (latest.moderation_status === 'removed') return 'Message removed by moderation';
    if (latest.metadata?.type === 'call') {
      const mode = latest.metadata.mode === 'video' ? 'Video' : 'Voice';
      const status = {
        ringing: 'calling',
        accepted: 'connected',
        declined: 'declined',
        ended: 'ended'
      }[latest.metadata.status] || 'call';
      return `${mode} call · ${status}`;
    }
    if (latest.body) return latest.body;
    if (latest.attachment) return `Attachment: ${latest.attachment.name}`;
    return 'Conversation update';
  }

  function conversationMenuItems(conversation) {
    const mutedLabel = conversation.muted ? 'Unmute conversation' : 'Mute conversation';
    const mutedIcon = conversation.muted ? 'bx-volume-full' : 'bx-volume-mute';
    const items = isAssistantConversation(conversation) ? [
      `<button type="button" role="menuitem" data-conversation-action="details"><i class="bx bx-info-circle"></i><span><strong>AI details</strong><small>Capabilities, privacy and reminders</small></span></button>`
    ] : [
      `<button type="button" role="menuitem" data-conversation-action="content"><i class="bx bx-folder-open"></i><span><strong>Media, files & links</strong><small>Browse everything shared</small></span></button>`,
      `<button type="button" role="menuitem" data-conversation-action="details"><i class="bx bx-info-circle"></i><span><strong>Chat details</strong><small>Members, status and controls</small></span></button>`
    ];
    if (!isAssistantConversation(conversation)) {
      items.push(`<button type="button" role="menuitem" data-conversation-action="mute"><i class="bx ${mutedIcon}"></i><span><strong>${mutedLabel}</strong><small>Change Inbox alerts</small></span></button>`);
    }
    if (conversation.kind === 'direct') {
      items.push('<button type="button" role="menuitem" data-conversation-action="schedule"><i class="bx bx-calendar-plus"></i><span><strong>Schedule a session</strong><small>Open Calendar with this member</small></span></button>');
      items.push('<button type="button" role="menuitem" data-conversation-action="report"><i class="bx bx-flag"></i><span><strong>Report activity</strong><small>Send evidence to moderation</small></span></button>');
    }
    if (conversation.kind === 'meeting') {
      items.push('<button type="button" role="menuitem" data-conversation-action="calendar"><i class="bx bx-calendar-detail"></i><span><strong>Meeting calendar</strong><small>View the shared session</small></span></button>');
    }
    if (conversation.kind === 'group') {
      if (conversation.viewer_is_group_admin) {
        items.push('<button type="button" role="menuitem" data-conversation-action="edit-group"><i class="bx bx-edit-alt"></i><span><strong>Edit group</strong><small>Name, logo, members and admins</small></span></button>');
      }
      items.push('<button type="button" role="menuitem" data-conversation-action="report"><i class="bx bx-flag"></i><span><strong>Report group activity</strong><small>Choose a member and evidence</small></span></button>');
      items.push('<button class="danger" type="button" role="menuitem" data-conversation-action="leave-group"><i class="bx bx-log-out"></i><span><strong>Leave group</strong><small>Remove this chat from your account</small></span></button>');
    }
    if (isAssistantConversation(conversation)) {
      items.push('<div class="conversation-menu-note"><i class="bx bx-sparkles"></i><span><strong>Private AI workspace</strong><small>Your messages and reminders are saved to your signed-in account.</small></span></div>');
      items.push('<button class="danger" type="button" role="menuitem" data-conversation-action="clear-assistant"><i class="bx bx-eraser"></i><span><strong>Clear AI history</strong><small>Remove your assistant messages and reminders</small></span></button>');
      return items.join('');
    }
    items.push('<button class="danger" type="button" role="menuitem" data-conversation-action="clear"><i class="bx bx-eraser"></i><span><strong>Clear chat for me</strong><small>Other members keep their copy</small></span></button>');
    items.push('<button class="danger" type="button" role="menuitem" data-conversation-action="delete"><i class="bx bx-trash"></i><span><strong>Delete chat</strong><small>Remove the conversation from your Inbox</small></span></button>');
    return items.join('');
  }

  function closeConversationContextMenu() {
    const menu = $('#conversationContextMenu');
    if (menu) menu.hidden = true;
    $$('[data-conversation-menu]').forEach(button => button.setAttribute('aria-expanded', 'false'));
    state.conversationMenuId = '';
  }

  function openConversationContextMenu(conversation, button) {
    const menu = $('#conversationContextMenu');
    if (!menu || !button) return;
    if (state.conversationMenuId === conversation.id && !menu.hidden) {
      closeConversationContextMenu();
      return;
    }
    state.conversationMenuId = conversation.id;
    menu.dataset.conversationId = conversation.id;
    const menuAvatar = isAssistantConversation(conversation) ? avatarHtml(assistantProfile(), true) :
      conversation.kind === 'group' ? groupAvatarHtml(conversation) :
      conversation.kind === 'meeting' ? meetingAvatarHtml() :
      avatarHtml(conversation.members?.[0], false);
    menu.innerHTML = `<div class="conversation-context-title"><span>${menuAvatar}<strong>${escapeHtml(conversation.title)}</strong></span><small>${escapeHtml(conversation.subtitle || 'Conversation options')}</small></div>${conversationMenuItems(conversation)}`;
    menu.hidden = false;
    $$('[data-conversation-menu]').forEach(item => item.setAttribute('aria-expanded', String(item === button)));
    const buttonRect = button.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(buttonRect.right - menuRect.width, window.innerWidth - menuRect.width - 8));
    const preferredTop = buttonRect.bottom + 6;
    const top = preferredTop + menuRect.height <= window.innerHeight - 8 ? preferredTop : Math.max(8, buttonRect.top - menuRect.height - 6);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  function renderConversationList() {
    const host = $('#conversationList');
    if (!host || !state.inbox) return;
    const term = String($('#conversationSearch')?.value || '').trim().toLowerCase();
    const seenBots = new Set();
    const conversations = state.inbox.conversations
      .filter(item => {
        // Meeting-only bot notices are mirrored into SwapBot and remain
        // reachable from Calendar without crowding the assistant list.
        if (item.bot_only) return false;
        if (isAssistantConversation(item)) {
          if (seenBots.size) return false;
          seenBots.add(item.id);
        }
        return `${item.title} ${item.subtitle} ${conversationPreview(item)}`.toLowerCase().includes(term);
      })
      .sort((first, second) => {
        const firstBot = isAssistantConversation(first);
        const secondBot = isAssistantConversation(second);
        if (firstBot !== secondBot) return firstBot ? -1 : 1;
        return 0;
      });
    host.innerHTML = conversations.length ? conversations.map(conversation => {
        const bot = isAssistantConversation(conversation);
        const assistant = bot;
        const meeting = conversation.kind === 'meeting';
        const group = conversation.kind === 'group';
        const member = conversation.members?.[0];
        const active = conversation.id === state.activeConversationId;
        return `<div class="conversation-row ${assistant ? 'assistant pinned' : ''} ${active ? 'active' : ''}">
          <button class="conversation-item ${meeting ? 'meeting' : ''} ${group ? 'group' : ''} ${assistant ? 'assistant' : ''} ${active ? 'active' : ''}" type="button" data-conversation-id="${escapeAttr(conversation.id)}">
            ${meeting ? meetingAvatarHtml() : group ? groupAvatarHtml(conversation) : avatarHtml(assistant ? assistantProfile() : member, bot)}
            <span class="conversation-copy"><strong>${meeting ? '<i class="bx bx-video meeting-thread-mark"></i>' : group ? '<i class="bx bx-group meeting-thread-mark"></i>' : ''}${escapeHtml(conversation.title)}</strong><span>${escapeHtml(conversationPreview(conversation))}</span></span>
            <span class="conversation-meta"><time>${escapeHtml(conversation.latest_message ? relativeTime(conversation.latest_message.created_at) : '')}</time>${assistant ? '<i class="bx bx-sparkles conversation-pin" title="SwapBot"></i>' : ''}${conversation.unread_count ? `<b class="conversation-badge">${conversation.unread_count > 99 ? '99+' : conversation.unread_count}</b>` : ''}</span>
          </button>
          <button class="conversation-row-more" type="button" data-conversation-menu="${escapeAttr(conversation.id)}" aria-label="More options for ${escapeAttr(conversation.title)}" aria-haspopup="menu" aria-expanded="false"><i class="bx bx-dots-vertical-rounded"></i></button>
        </div>`;
      }).join('') :
      '<div class="ops-empty"><i class="bx bx-search-alt"></i><h3>No matching conversations</h3><p>Try another name or message keyword.</p></div>';
    $('#inboxUnreadCount').textContent = String(state.inbox.unread_count || 0);
    $('#inboxConversationCount').textContent = String(conversations.length);
  }

  function clearLocalConversationUnread(conversationId) {
    const item = state.inbox?.conversations.find(entry => entry.id === conversationId);
    if (!item) return false;
    const hadUnread = Number(item.unread_count || 0) > 0;
    item.unread_count = 0;
    if (state.inbox) {
      state.inbox.unread_count = state.inbox.conversations.reduce((total, entry) => total + Number(entry.unread_count || 0), 0);
    }
    renderConversationList();
    if (hadUnread) window.dispatchEvent(new CustomEvent('swaplabs:inbox-read', {
      detail: {conversationId, optimistic: true}
    }));
    return hadUnread;
  }

  async function ensureInboxContacts({quiet = false} = {}) {
    if (!state.inbox) return [];
    if (Array.isArray(state.inbox.contacts) && state.inbox.contacts.length) return state.inbox.contacts;
    if (state.inboxContactsRequest) return state.inboxContactsRequest;
    const request = api('/api/inbox/contacts').then(result => {
      state.inbox.contacts = Array.isArray(result.contacts) ? result.contacts : [];
      renderInboxContacts();
      return state.inbox.contacts;
    }).catch(error => {
      if (!quiet) toast(error.message, 'error');
      return [];
    });
    state.inboxContactsRequest = request;
    try {
      return await request;
    } finally {
      if (state.inboxContactsRequest === request) state.inboxContactsRequest = null;
    }
  }

  function renderInboxContacts() {
    const select = $('#newChatMember');
    if (!select || !state.inbox) return;
    const current = select.value;
    select.innerHTML = '<option value="">Start a conversation</option>' + state.inbox.contacts.map(member =>
      `<option value="${escapeAttr(member.id)}">${escapeHtml(member.display_name)} · @${escapeHtml(member.username)}</option>`
      ).join('');
    if (state.inbox.contacts.some(member => member.id === current)) select.value = current;
  }

  function renderFollowRequests() {
    const requests = state.inbox?.incoming_requests || [];
    $('#requestCount').textContent = `${requests.length} follow request${requests.length === 1 ? '' : 's'}`;
    const host = $('#followRequestStack');
    if (!host) return;
    host.innerHTML = requests.length ? requests.map(item => `<article class="follow-request-card">
      <div class="follow-request-person">${avatarHtml(item.requester)}<div><strong>${escapeHtml(item.requester.display_name)}</strong><span>@${escapeHtml(item.requester.username)}</span></div></div>
      <div class="follow-request-actions"><button type="button" data-follow-accept="${escapeAttr(item.id)}"><i class="bx bx-check"></i> Accept</button><button type="button" data-follow-decline="${escapeAttr(item.id)}"><i class="bx bx-x"></i> Delete</button></div>
    </article>`).join('') : '<p class="ops-muted">No pending profile requests.</p>';
  }

  async function loadInbox({
    selectFirst = false,
    quiet = false
  } = {}) {
    if (state.inboxRequest) return state.inboxRequest;
    const request = (async () => {
      try {
        let result;
        try {
          result = await api('/api/inbox');
        } catch (error) {
          // A stale host-only cookie or a transient fetch failure can leave the
          // navbar looking signed in while the first inbox request is rejected.
          // Revalidate once so the server can migrate the session cookie and
          // retry the same-origin request before showing an error.
          if (!state.user || (error.status && error.status !== 401)) throw error;
          const authResponse = await fetch('/api/auth/me', {
            credentials: 'same-origin',
            cache: 'no-store',
            mode: 'same-origin'
          });
          if (!authResponse.ok) throw error;
          const auth = await authResponse.json();
          if (!auth.authenticated) {
            const expired = new Error('Your sign-in session has expired. Please log in again.');
            expired.status = 401;
            throw expired;
          }
          state.user = auth.user;
          state.csrf = auth.csrf_token || state.csrf;
          window.SwapLabsAuth?.remember?.(auth.user);
          result = await api('/api/inbox');
        }
        const serverAssistant = result.conversations?.find(item => item.kind === 'bot');
        result.conversations = [
          assistantConversation(serverAssistant || {}),
          ...(result.conversations || []).filter(item => !isAssistantConversation(item))
        ];
        // A refresh can have started just before the detail request marked the
        // active chat as read. Do not let that older response repaint the
        // conversation badge while the member is still inside the chat.
        if (state.activeConversationId) {
          const activeConversation = result.conversations.find(item => item.id === state.activeConversationId);
          if (activeConversation) activeConversation.unread_count = 0;
          result.unread_count = result.conversations.reduce((total, item) => total + Number(item.unread_count || 0), 0);
        }
        state.inbox = result;
        renderInboxContacts();
        renderFollowRequests();
        renderConversationList();
        if ((selectFirst || !state.activeConversationId) && result.conversations.length) {
          const preferred = result.conversations.find(item => item.kind === 'bot') || result.conversations[0];
          await openConversation(preferred.id, true);
        }
      } catch (error) {
        if (!quiet) toast(error.message, 'error');
      }
    })();
    state.inboxRequest = request;
    try {
      return await request;
    } finally {
      if (state.inboxRequest === request) state.inboxRequest = null;
    }
  }

  function messageDayLabel(value) {
    const date = new Date(value);
    const today = new Date();
    if (date.toDateString() === today.toDateString()) return 'Today';
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium'
    }).format(date);
  }

  function meetingMessageCard(message) {
    const event = message.metadata?.event;
    if (!event) return '';
    const action = String(message.metadata?.calendar_action || 'updated');
    const actionLabels = {
      scheduled: 'Meeting scheduled',
      rescheduled: 'Time updated',
      updated: 'Meeting details updated',
      cancelled: 'Meeting cancelled',
      reminder: 'Meeting reminder',
      room_update: 'Live room update',
      attendance: 'Attendance confirmed'
    };
    const duration = Number(event.duration_minutes || Math.max(1,
      Math.round((new Date(event.ends_at) - new Date(event.starts_at)) / 60000)));
    const attendees = [event.host?.display_name, ...(event.participants || []).map(member => member.display_name)]
      .filter(Boolean);
    const meetingLocation = event.meeting_url ?
      `<a href="${escapeAttr(event.meeting_url)}" target="_blank" rel="noopener"><i class="bx bx-link-external"></i> Open meeting link</a>` :
      `<span><i class="bx bx-map"></i>${escapeHtml(event.location || 'Location not set')}</span>`;
    return `<article class="meeting-message-card ${action === 'cancelled' ? 'cancelled' : ''}">
      <div class="meeting-message-top"><span><i class="bx ${action === 'cancelled' ? 'bx-calendar-x' : action === 'rescheduled' ? 'bx-refresh' : action === 'reminder' ? 'bx-alarm' : action === 'room_update' ? 'bx-video' : action === 'attendance' ? 'bx-award' : 'bx-calendar-check'}"></i>${escapeHtml(actionLabels[action] || actionLabels.updated)}</span><time>${escapeHtml(formatShortTime(message.created_at))}</time></div>
      <h3>${escapeHtml(event.title || 'SwapLabs meeting')}</h3>
      ${event.description ? `<p>${escapeHtml(event.description)}</p>` : ''}
      <div class="meeting-message-facts"><span><i class="bx bx-calendar"></i><strong>${escapeHtml(formatDate(event.starts_at))}</strong></span><span><i class="bx bx-time-five"></i><strong>${duration} minutes</strong></span><span><i class="bx bx-globe"></i><strong>${escapeHtml(event.timezone || 'UTC')}</strong></span>${meetingLocation}</div>
      <div class="meeting-message-people"><i class="bx bx-group"></i><span><small>Everyone invited</small><strong>${escapeHtml(attendees.join(', ') || 'No attendees listed')}</strong></span></div>
      <div class="meeting-message-actions"><a href="calendar.html?event=${encodeURIComponent(event.id)}"><i class="bx bx-calendar-detail"></i> View calendar details</a>${action !== 'cancelled' ? `<a href="video-room.html?event=${encodeURIComponent(event.id)}"><i class="bx bx-video"></i> Open live room</a>` : ''}<a href="/api/calendar/events/${encodeURIComponent(event.id)}/ics"><i class="bx bx-download"></i> Download ICS</a></div>
    </article>`;
  }

  function callMessageCard(message, conversation) {
    const metadata = message.metadata || {};
    const mode = metadata.mode === 'video' ? 'video' : 'voice';
    const status = String(metadata.status || 'ringing');
    const statusLabel = {
      ringing: 'Calling…',
      accepted: 'Connected',
      declined: 'Declined',
      ended: 'Call ended',
      missed: 'No answer'
    }[status] || 'Call update';
    const peer = (conversation?.conversation?.members || []).find(member => member.id !== state.user.id) || conversation?.conversation?.members?.[0];
    const roomId = String(metadata.room_id || '');
    const callId = String(metadata.call_id || '');
    const canOpen = Boolean(roomId && callId && ['accepted', 'ringing'].includes(status) && (message.sender_id === state.user.id || status === 'accepted'));
    const canRedial = Boolean(peer?.id && ['declined', 'ended', 'missed'].includes(status));
    const label = mode === 'video' ? 'Video call' : 'Voice call';
    const icon = mode === 'video' ? 'bx-video' : 'bx-phone';
    return `<article class="call-message-card ${status}">
      <div class="call-message-top"><span><i class="bx ${icon}"></i>${label}</span><time>${escapeHtml(formatShortTime(message.created_at))}</time></div>
      <div class="call-message-main"><span class="call-message-icon"><i class="bx ${icon}"></i></span><span><strong>${escapeHtml(statusLabel)}</strong><small>1 credit · SwapLabs call</small></span></div>
      ${(canOpen || canRedial) ? `<div class="call-message-actions">${canOpen ? `<a href="video-room.html?room=${encodeURIComponent(roomId)}&call=${encodeURIComponent(callId)}"><i class="bx bx-log-in-circle"></i> Open call</a>` : ''}${canRedial ? `<button type="button" data-call-redial="${escapeAttr(peer.id)}" data-call-mode="${escapeAttr(mode)}"><i class="bx bx-phone-call"></i> Call again</button>` : ''}</div>` : ''}
    </article>`;
  }

  function botMessageContent(message) {
    const metadata = message.metadata || {};
    const links = Array.isArray(metadata.links) ? metadata.links.filter(link => /^[a-z0-9][a-z0-9-]*\.html(?:[?#].*)?$/i.test(link.href || '')) : [];
    const followups = Array.isArray(metadata.followups) ? metadata.followups.slice(0, 4) : [];
    const interpreted = Array.isArray(metadata.interpreted_as) && metadata.interpreted_as.length ? `<span class="swapbot-interpreted"><i class="bx bx-spell-check"></i> Understood as: ${escapeHtml(metadata.interpreted_as.join(', '))}</span>` : '';
    return `<article class="swapbot-answer"><div class="swapbot-answer-head"><span><i class="bx bx-sparkles"></i>${escapeHtml(metadata.article_title || 'SwapBot answer')}</span>${metadata.confidence ? `<small>${Math.round(Number(metadata.confidence) * 100)}% match</small>` : ''}</div>${interpreted}<p>${escapeHtml(message.body || '').replace(/\n/g, '<br>')}</p>${links.length ? `<div class="swapbot-link-grid">${links.map(link => `<a href="${escapeAttr(link.href)}"><i class="bx ${escapeAttr(link.icon || 'bx-link-external')}"></i><span>${escapeHtml(link.label)}</span><i class="bx bx-chevron-right"></i></a>`).join('')}</div>` : ''}${followups.length ? `<div class="swapbot-followups"><span>Ask next</span>${followups.map(question => `<button type="button" data-bot-followup="${escapeAttr(question)}">${escapeHtml(question)}</button>`).join('')}</div>` : ''}</article>`;
  }

  function messageHtml(message, conversation) {
    const mine = message.sender_id === state.user.id;
    const bot = message.sender_kind === 'bot';
    const system = message.sender_kind === 'system';
    const meetingUpdate = message.metadata?.type === 'calendar_event' && message.metadata?.event;
    const callUpdate = message.metadata?.type === 'call';
    const member = message.sender;
    const othersRead = (message.read_by || []).some(id => id !== state.user.id);
    const attachment = message.attachment ?
      `<a class="message-attachment" href="${escapeAttr(message.attachment.url)}"><i class="bx ${String(message.attachment.mime || '').startsWith('image/') ? 'bx-image' : message.attachment.mime === 'application/pdf' ? 'bxs-file-pdf' : 'bx-file'}"></i><span><strong>${escapeHtml(message.attachment.name)}</strong><small>${Math.max(1, Math.round(Number(message.attachment.size || 0) / 1024))} KB · Download protected file</small></span></a>` :
      '';
    const canPin = conversation?.conversation?.kind === 'group' && conversation.conversation.viewer_is_group_admin && !system;
    return `<div class="message-row ${mine ? 'mine' : ''} ${bot ? 'bot' : ''} ${system ? 'system' : ''} ${meetingUpdate ? 'meeting-update' : ''} ${callUpdate ? 'call-update' : ''} ${message.pinned ? 'pinned' : ''} ${message.moderation_status === 'removed' ? 'removed' : ''}" data-message-id="${escapeAttr(message.id)}">
      ${!mine && !system ? avatarHtml(bot ? assistantProfile() : member, bot) : ''}
      <div class="message-bubble">${message.pinned ? '<span class="message-pinned-label"><i class="bx bx-pin"></i> Pinned</span>' : ''}${meetingUpdate ? meetingMessageCard(message) : callUpdate ? callMessageCard(message, conversation) : bot ? botMessageContent(message) : `${!mine && !system ? `<span class="message-author">${escapeHtml(member?.display_name || 'Member')}</span>` : ''}${message.body ? `<p>${escapeHtml(message.body)}</p>` : ''}${attachment}${!system ? `<span class="message-state">${escapeHtml(formatShortTime(message.created_at))}${mine ? ` · <i class="bx bx-check${othersRead ? '-double' : ''}"></i> ${othersRead ? 'Read' : 'Sent'}` : ''}</span>` : ''}`}${canPin ? `<button class="message-pin-action" type="button" data-pin-message="${escapeAttr(message.id)}" data-pinned="${message.pinned ? 'true' : 'false'}"><i class="bx bx-pin"></i>${message.pinned ? 'Unpin' : 'Pin'}</button>` : ''}</div>
    </div>`;
  }

  function renderMessages(scroll = false) {
    const host = $('#messageStream');
    if (!host || !state.activeConversation) return;
    let currentDay = '';
    const html = state.activeMessages.map(message => {
      const day = messageDayLabel(message.created_at);
      const divider = day !== currentDay ? `<div class="message-day"><span>${escapeHtml(day)}</span></div>` : '';
      currentDay = day;
      return divider + messageHtml(message, state.activeConversation);
    }).join('');
    const wasNearBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 110;
    host.innerHTML = html ||
      '<div class="ops-empty"><i class="bx bx-message"></i><h3>No messages yet</h3><p>Write the first message in this conversation.</p></div>';
    if (scroll || wasNearBottom) host.scrollTop = host.scrollHeight;
    const typing = $('#typingLine');
    if (typing) {
      const names = state.activeConversation.typing_users || [];
      typing.hidden = names.length === 0;
      const label = $('em', typing);
      if (label && names.length) label.textContent = `${names.map(item => item.display_name).join(', ')} typing`;
    }
  }

  function renderConversationDetails() {
    const host = $('#detailsConversation');
    if (!host || !state.activeConversation) return;
    const conversation = state.activeConversation.conversation;
    const voiceCallButton = $('#chatVoiceCall');
    const videoCallButton = $('#chatVideoCall');
    const setCallActions = visible => {
      if (voiceCallButton) voiceCallButton.hidden = !visible;
      if (videoCallButton) videoCallButton.hidden = !visible;
    };
    setCallActions(false);
    if (isAssistantConversation(conversation)) {
      host.innerHTML =
        `<div class="details-profile">${avatarHtml(assistantProfile(), true)}<h3>SwapBot</h3><p>Private website guide, reminder keeper, and exchange assistant</p></div><div class="details-info"><div><span>Knowledge areas</span><strong>Platform-wide FAQ</strong></div><div><span>Access</span><strong>Private to you</strong></div><div><span>Messages</span><strong>${state.activeMessages.length}</strong></div><div><span>Reminders</span><strong>${readAssistantReminders().filter(item => !item.completed && !item.dismissed).length} active</strong></div></div><div class="swapbot-starter-prompts"><strong>Try asking</strong>${['What should I do next?','How do I find the best skill match?','Show me how recurring events work','How do I earn credits?','Show my reminders','Remind me to review my profile tomorrow at 7pm'].map(question => `<button type="button" data-bot-followup="${escapeAttr(question)}"><i class="bx bx-sparkles"></i>${escapeHtml(question)}</button>`).join('')}</div><div class="ops-trust-note"><i class="bx bx-shield-quarter"></i><span>Answers use SwapLabs’ published product guidance. Personal reminders are stored in this signed-in browser account.</span></div>`;
      $('#chatSchedule').hidden = false;
      $('#chatSchedule').dataset.scheduleHref = 'calendar.html';
      return;
    }
    if (conversation.kind === 'meeting') {
      const event = conversation.event;
      const attendees = [event?.host, ...(event?.participants || [])].filter(Boolean);
      $('#chatSchedule').hidden = false;
      $('#chatSchedule').dataset.scheduleHref = event ? `calendar.html?event=${encodeURIComponent(event.id)}` : 'calendar.html';
      host.innerHTML = event ?
        `<div class="details-profile meeting-profile">${meetingAvatarHtml()}<h3>${escapeHtml(event.title)}</h3><p>${event.status === 'cancelled' ? 'Cancelled meeting' : 'Shared meeting thread'}</p></div>
        <div class="meeting-detail-summary"><span><i class="bx bx-calendar"></i><strong>${escapeHtml(formatDate(event.starts_at))}</strong></span><span><i class="bx bx-time-five"></i><strong>${Math.max(1,Math.round((new Date(event.ends_at)-new Date(event.starts_at))/60000))} minutes</strong></span><span><i class="bx bx-globe"></i><strong>${escapeHtml(event.timezone || 'UTC')}</strong></span><span><i class="bx bx-map"></i><strong>${escapeHtml(event.meeting_url ? 'Online meeting' : event.location || 'Location not set')}</strong></span></div>
        <div class="meeting-detail-members"><span>Members in this meeting</span><div>${attendees.map(member => `<span>${avatarHtml(member)}<strong>${escapeHtml(member.display_name)}</strong></span>`).join('')}</div></div>
        <div class="details-actions"><a class="details-action" href="calendar.html?event=${encodeURIComponent(event.id)}"><i class="bx bx-calendar-detail"></i> Calendar</a>${event.status !== 'cancelled' ? `<a class="details-action" href="video-room.html?event=${encodeURIComponent(event.id)}"><i class="bx bx-video"></i> Live room</a>` : ''}<a class="details-action" href="/api/calendar/events/${encodeURIComponent(event.id)}/ics"><i class="bx bx-download"></i> Export</a></div>
        <div class="ops-trust-note"><i class="bx bx-info-circle"></i><span>Scheduling, rescheduling, cancellation, room, and attendance updates stay visible to every meeting member in this thread.</span></div>` :
        '<p class="ops-muted">This meeting record is no longer available.</p>';
      return;
    }
    if (conversation.kind === 'group') {
      $('#chatSchedule').hidden = true;
      const selfMember = {
        id: state.user.id,
        username: state.user.username,
        role: state.user.role,
        display_name: state.user.profile?.display_name || state.user.username,
        avatar_url: state.user.profile?.avatar_url || '',
        profile_color: state.user.profile?.profile_color || 'indigo'
      };
      const members = [selfMember, ...(conversation.members || [])];
      const adminIds = new Set(conversation.group_admin_ids || []);
      host.innerHTML = `<div class="details-profile group-profile">${groupAvatarHtml(conversation)}<h3>${escapeHtml(conversation.title)}</h3><p>${escapeHtml(conversation.description || `${members.length} people sharing skills together`)}</p></div>
        <div class="group-detail-heading"><span>Members</span><strong>${members.length}</strong></div>
        <div class="group-detail-members">${members.map(member => `<span>${avatarHtml(member)}<span><strong>${escapeHtml(member.display_name)}${member.id === state.user.id ? ' · You' : ''}</strong><small>@${escapeHtml(member.username)}${member.role === 'admin' ? ' · Platform administrator' : ''}</small></span>${adminIds.has(member.id) ? '<i class="bx bx-shield-quarter" title="Group administrator"></i>' : ''}</span>`).join('')}</div>
        <div class="details-actions group-details-actions"><button class="details-action" type="button" data-group-content><i class="bx bx-folder-open"></i> Shared content</button><button class="details-action" type="button" data-group-mute><i class="bx ${conversation.muted ? 'bx-volume-full' : 'bx-volume-mute'}"></i> ${conversation.muted ? 'Unmute' : 'Mute'}</button>${conversation.viewer_is_group_admin ? '<button class="details-action" type="button" data-group-edit><i class="bx bx-edit-alt"></i> Edit group</button>' : ''}<button class="details-action" type="button" data-group-report><i class="bx bx-flag"></i> Report</button></div>
        <button class="details-action danger group-leave-action" type="button" data-group-leave><i class="bx bx-log-out"></i> Leave group</button>
        <div class="ops-trust-note"><i class="bx bx-shield-quarter"></i><span>Group administrators can update the name, logo, members, and admin roles. Platform administrators only join when someone selects their account.</span></div>`;
      return;
    }
    const member = conversation.members?.[0];
    if (!member) {
      $('#chatSchedule').hidden = true;
      host.innerHTML =
        '<p class="ops-muted">This member account is no longer available. The conversation remains as moderation and account history.</p>';
      return;
    }
    setCallActions(true);
    $('#chatSchedule').hidden = false;
    $('#chatSchedule').dataset.participantId = member.id;
    $('#chatSchedule').dataset.conversationId = conversation.id;
    $('#chatSchedule').dataset.scheduleHref =
      `calendar.html?participant=${encodeURIComponent(member.id)}&conversation=${encodeURIComponent(conversation.id)}`;
    host.innerHTML =
      `<div class="details-profile">${avatarHtml(member)}<h3>${escapeHtml(member.display_name)}</h3><p>@${escapeHtml(member.username)}${member.verified ? ' · Verified' : ''}</p></div>
      <div class="details-actions"><a class="details-action" href="member-profile.html?id=${encodeURIComponent(member.id)}"><i class="bx bx-id-card"></i> Portfolio</a><a class="details-action" href="calendar.html?participant=${encodeURIComponent(member.id)}&conversation=${encodeURIComponent(conversation.id)}"><i class="bx bx-calendar-plus"></i> Schedule</a><button class="details-action" type="button" data-conversation-mute><i class="bx ${conversation.muted ? 'bx-volume-full' : 'bx-volume-mute'}"></i> ${conversation.muted ? 'Unmute' : 'Mute'}</button><button class="details-action danger" type="button" data-conversation-block><i class="bx ${conversation.blocked ? 'bx-lock-open-alt' : 'bx-block'}"></i> ${conversation.blocked ? 'Unblock' : 'Block'}</button></div>
      <button class="details-action danger" style="width:100%" type="button" data-conversation-report><i class="bx bx-flag"></i> Report conversation activity</button>
      <div class="details-info"><div><span>Message alerts</span><strong>${conversation.muted ? 'Muted' : 'On'}</strong></div><div><span>Connection</span><strong>${conversation.blocked ? 'Blocked' : 'Available'}</strong></div><div><span>Messages</span><strong>${state.activeMessages.length}</strong></div><div><span>Started</span><strong>${escapeHtml(formatDay(conversation.created_at))}</strong></div></div>`;
  }

  function refreshChatInfoModal() {
    const modal = $('#chatInfoModal');
    const source = $('#detailsConversation');
    const target = $('#chatInfoContent');
    if (!modal || modal.hidden || !source || !target) return;
    target.innerHTML = source.innerHTML;
  }

  function closeChatInfoModal() {
    const modal = $('#chatInfoModal');
    if (!modal) return;
    modal.hidden = true;
    $('#chatHeading')?.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
  }

  async function openChatInfoModal(conversation = state.activeConversation?.conversation) {
    if (!conversation) return;
    if (state.activeConversationId !== conversation.id) {
      await openConversation(conversation.id);
    }
    const current = state.activeConversation?.conversation || conversation;
    const modal = $('#chatInfoModal');
    const title = $('#chatInfoTitle');
    const subtitle = $('#chatInfoSubtitle');
    const content = $('#chatInfoContent');
    if (!modal || !content) return;
    title.textContent = isAssistantConversation(current) ? 'SwapBot' : current.title || 'Conversation details';
    subtitle.textContent = isAssistantConversation(current) ?
      'Private assistant details, reminders, and useful links.' :
      current.subtitle || 'Members, shared content, and conversation controls.';
    content.innerHTML = $('#detailsConversation')?.innerHTML || '<p class="ops-muted">Chat details are loading.</p>';
    modal.hidden = false;
    $('#chatHeading')?.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
    window.setTimeout(() => $('[data-close-chat-info]')?.focus(), 40);
  }

  async function loadConversation(conversationId, {
    quiet = false,
    scroll = false
  } = {}) {
    if (conversationId === AI_CONVERSATION_ID) {
      if (state.activeConversationId !== conversationId) return;
      const conversation = assistantConversation(state.inbox?.conversations.find(item => item.id === conversationId) || {});
      const oldLast = state.activeMessages.at(-1)?.id;
      state.activeConversation = {conversation, messages: readAssistantMessages(), typing_users: []};
      state.activeMessages = state.activeConversation.messages;
      const heading = $('#chatHeading');
      if (heading) heading.innerHTML = `${avatarHtml(assistantProfile(), true)}<span class="chat-heading-copy"><strong>SwapBot</strong><span>Online · private platform assistant</span></span>`;
      renderMessages(scroll || oldLast !== state.activeMessages.at(-1)?.id);
      renderConversationDetails();
      refreshChatInfoModal();
      renderConversationList();
      return;
    }
    const existingRequest = state.conversationRequests.get(conversationId);
    if (existingRequest) return existingRequest;
    const request = (async () => {
      try {
        const result = await api(`/api/inbox/conversations/${encodeURIComponent(conversationId)}`);
        if (state.activeConversationId !== conversationId) return;
        const oldLast = state.activeMessages.at(-1)?.id;
        state.activeConversation = result;
        state.activeConversation.typing_users = result.typing_users || [];
        state.activeMessages = result.messages || [];
        const inboxItem = state.inbox?.conversations.find(item => item.id === conversationId);
        if (inboxItem) {
          inboxItem.latest_message = result.conversation?.latest_message || inboxItem.latest_message;
          inboxItem.updated_at = result.conversation?.updated_at || inboxItem.updated_at;
          inboxItem.unread_count = 0;
          state.inbox.unread_count = state.inbox.conversations.reduce((total, item) => total + Number(item.unread_count || 0), 0);
        }
        const heading = $('#chatHeading');
        if (heading) {
          const bot = isAssistantConversation(result.conversation);
          const meeting = result.conversation.kind === 'meeting';
          const group = result.conversation.kind === 'group';
          const member = result.conversation.members?.[0];
          heading.innerHTML =
            `${meeting ? meetingAvatarHtml() : group ? groupAvatarHtml(result.conversation) : avatarHtml(bot ? assistantProfile() : member, bot)}<span class="chat-heading-copy"><strong>${escapeHtml(bot ? 'SwapBot' : result.conversation.title)}</strong><span>${escapeHtml(result.conversation.subtitle || (bot ? 'Online · private platform assistant' : 'Private member conversation'))}</span></span>`;
        }
        renderMessages(scroll || oldLast !== state.activeMessages.at(-1)?.id);
        renderConversationDetails();
        refreshChatInfoModal();
        // The detail endpoint is the authoritative read action. Clear the
        // local snapshot and refresh the global badge after the server has
        // committed the read watermark, avoiding a stale badge race.
        clearLocalConversationUnread(conversationId);
        window.dispatchEvent(new CustomEvent('swaplabs:inbox-read', {
          detail: {conversationId, confirmed: true}
        }));
        return result;
      } catch (error) {
        if (!quiet) toast(error.message, 'error');
      }
    })();
    state.conversationRequests.set(conversationId, request);
    try {
      return await request;
    } finally {
      if (state.conversationRequests.get(conversationId) === request) state.conversationRequests.delete(conversationId);
    }
  }

  async function openConversation(conversationId, initial = false) {
    state.activeConversationId = conversationId;
    // Make the sidebar and badge respond instantly while the conversation
    // detail request persists the read watermark in the background.
    clearLocalConversationUnread(conversationId);
    $('#chatEmpty')?.setAttribute('hidden', '');
    $('#chatActive')?.removeAttribute('hidden');
    $('#detailsDefault')?.setAttribute('hidden', '');
    $('#detailsConversation')?.removeAttribute('hidden');
    if (!initial || window.innerWidth >= 760) $('#inboxWorkspace')?.classList.add('chat-open');
    renderConversationList();
    await loadConversation(conversationId, {
      scroll: true
    });
    if (!initial && window.innerWidth < 760) $('#inboxDetails')?.classList.remove('open');
  }

  async function sendTyping(typing) {
    if (!state.activeConversationId || state.activeConversationId === AI_CONVERSATION_ID) return;
    try {
      await api(`/api/inbox/conversations/${encodeURIComponent(state.activeConversationId)}/typing`, {
        method: 'POST',
        body: {
          typing
        }
      });
    } catch (_error) {
      /* Polling will recover. */ }
  }

  async function sendAssistantMessage(text) {
    const body = String(text || '').trim();
    if (!body || !state.user) return;
    const messages = readAssistantMessages();
    const userMessage = {
      id: `ai_msg_${Date.now().toString(36)}_user`,
      conversation_id: AI_CONVERSATION_ID,
      sender_id: state.user.id,
      sender_kind: 'member',
      sender: state.user,
      body,
      read_by: [state.user.id],
      created_at: new Date().toISOString()
    };
    messages.push(userMessage);
    writeAssistantMessages(messages);
    state.activeConversation = {conversation: assistantConversation(), messages, typing_users: [{display_name: 'SwapBot'}]};
    state.activeMessages = messages;
    renderMessages(true);
    renderConversationList();
    await new Promise(resolve => setTimeout(resolve, 420));
    const reply = await makeAssistantReply(body);
    const replyMessage = {
      id: `ai_msg_${Date.now().toString(36)}_assistant`,
      conversation_id: AI_CONVERSATION_ID,
      sender_id: AI_CONVERSATION_ID,
      sender_kind: 'bot',
      sender: assistantProfile(),
      body: reply.body,
      metadata: reply.metadata || {},
      read_by: [state.user.id],
      created_at: new Date().toISOString()
    };
    messages.push(replyMessage);
    writeAssistantMessages(messages);
    state.activeConversation = {conversation: assistantConversation(), messages, typing_users: []};
    state.activeMessages = messages;
    renderMessages(true);
    renderConversationDetails();
    refreshChatInfoModal();
    renderConversationList();
  }

  function openReportModal() {
    const conversation = state.activeConversation?.conversation;
    const targets = conversation?.members || [];
    if (!targets.length) return;
    const memberSelect = $('#reportMember');
    memberSelect.innerHTML = targets.map(member =>
      `<option value="${escapeAttr(member.id)}">${escapeHtml(member.display_name)} · @${escapeHtml(member.username)}${member.role === 'admin' ? ' · Platform administrator' : ''}</option>`
    ).join('');
    refreshReportMessageOptions();
    $('#reportMemberField').hidden = targets.length === 1;
    $('#reportModal').hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function refreshReportMessageOptions() {
    const targetId = $('#reportMember')?.value;
    const select = $('#reportMessage');
    select.innerHTML = '<option value="">Entire conversation</option>' + state.activeMessages.filter(message =>
      message.sender_id === targetId).map(message =>
      `<option value="${escapeAttr(message.id)}">${escapeHtml(formatShortTime(message.created_at))} · ${escapeHtml((message.body || message.attachment?.name || 'Attachment').slice(0, 90))}</option>`
      ).join('');
  }

  function closeReportModal() {
    $('#reportModal').hidden = true;
    document.body.style.overflow = '';
    $('#reportForm')?.reset();
    clearStatus($('#reportForm'));
  }

  function localDateTimeInput(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const pad = part => String(part).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function closeQuickSchedule() {
    const modal = $('#quickScheduleModal');
    if (!modal) return;
    modal.hidden = true;
    document.body.style.overflow = '';
    $('#quickScheduleForm')?.reset();
    clearStatus($('#quickScheduleForm'));
  }

  function openQuickSchedule(conversation = state.activeConversation?.conversation) {
    const member = conversation?.kind === 'direct' ? conversation.members?.[0] : null;
    const modal = $('#quickScheduleModal');
    const form = $('#quickScheduleForm');
    if (!member || !modal || !form) return;
    form.dataset.participantId = member.id;
    form.dataset.conversationId = conversation.id;
    form.elements.title.value = `Skill exchange with ${member.display_name || member.username}`;
    const start = new Date();
    start.setDate(start.getDate() + 1);
    start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15, 0, 0);
    form.elements.starts_at.value = localDateTimeInput(start);
    form.elements.duration.value = '60';
    form.elements.reminder.checked = true;
    clearStatus(form);
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    window.setTimeout(() => form.elements.starts_at?.focus(), 40);
  }

  async function submitQuickSchedule(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const starts = new Date(form.elements.starts_at.value);
    const duration = Math.max(15, Number(form.elements.duration.value || 60));
    if (Number.isNaN(starts.getTime())) return setStatus(form, 'Choose a valid start time.');
    const ends = new Date(starts.getTime() + duration * 60 * 1000);
    const button = $('button[type="submit"]', form);
    setButtonLoading(button, true, 'Scheduling');
    clearStatus(form);
    try {
      await api('/api/calendar/events', {
        method: 'POST',
        body: {
          title: form.elements.title.value.trim(),
          description: 'Scheduled from the private SwapLabs chat.',
          starts_at: starts.toISOString(),
          ends_at: ends.toISOString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
          participant_ids: [form.dataset.participantId],
          conversation_id: form.dataset.conversationId,
          location: '',
          meeting_url: '',
          reminders_minutes: form.elements.reminder.checked ? [60] : [],
          recurrence: 'none',
          recurrence_count: 1,
          all_day: false
        }
      });
      closeQuickSchedule();
      toast('Session scheduled and added to this chat.');
      if (state.activeConversationId) await loadConversation(state.activeConversationId, {quiet: true, scroll: true});
      await loadInbox({quiet: true});
    } catch (error) {
      setStatus(form, error.message);
      setButtonLoading(button, false);
    }
  }

  function groupConversationRecord(conversationId = state.editingGroupId) {
    return state.inbox?.conversations.find(item => item.id === conversationId) ||
      (state.activeConversation?.conversation?.id === conversationId ? state.activeConversation.conversation : null);
  }

  function renderGroupMemberPicker() {
    const host = $('#groupMemberPicker');
    if (!host || !state.inbox) return;
    const term = String($('#groupMemberSearch')?.value || '').trim().toLowerCase();
    const candidateMap = new Map(state.inbox.contacts.map(member => [member.id, member]));
    (groupConversationRecord()?.members || []).forEach(member => candidateMap.set(member.id, member));
    const members = [...candidateMap.values()].filter(member =>
      `${member.display_name} ${member.username} ${member.role}`.toLowerCase().includes(term));
    host.innerHTML = members.length ? members.map(member => {
      const selected = state.groupSelectedIds.has(member.id);
      const groupAdmin = state.groupAdminIds.has(member.id);
      return `<article class="group-member-option ${selected ? 'selected' : ''}">
        <label class="group-member-main"><input type="checkbox" data-group-member-id="${escapeAttr(member.id)}" ${selected ? 'checked' : ''}>${avatarHtml(member)}<span><strong>${escapeHtml(member.display_name)}</strong><small>@${escapeHtml(member.username)}${member.role === 'admin' ? ' · Platform administrator' : ''}</small></span><i class="bx bx-check"></i></label>
        <label class="group-admin-toggle ${selected ? '' : 'disabled'}"><input type="checkbox" data-group-admin-id="${escapeAttr(member.id)}" ${groupAdmin ? 'checked' : ''} ${selected ? '' : 'disabled'}><span><i class="bx bx-shield-quarter"></i> Group admin</span></label>
      </article>`;
    }).join('') : '<div class="ops-empty compact"><i class="bx bx-user-x"></i><h3>No accounts found</h3><p>Try another name or username.</p></div>';
    const selectedCount = state.groupSelectedIds.size;
    $('#groupSelectedCount').textContent = `${selectedCount} selected · ${selectedCount + 1} total`;
  }

  function setGroupLogoPreview(source = '') {
    const host = $('#groupLogoPreview');
    if (!host) return;
    host.innerHTML = source ? `<img src="${escapeAttr(source)}" alt="Selected group logo">` : '<i class="bx bx-group"></i>';
  }

  function openGroupModal(conversation = null) {
    const form = $('#groupChatForm');
    form?.reset();
    clearStatus(form);
    state.editingGroupId = conversation?.id || '';
    state.groupSelectedIds = new Set(
      (conversation?.participant_ids || []).filter(memberId => memberId !== state.user.id)
    );
    state.groupAdminIds = new Set(
      (conversation?.group_admin_ids || []).filter(memberId => memberId !== state.user.id)
    );
    $('#groupChatModalTitle').textContent = conversation ? 'Edit this group.' : 'Create a new group.';
    const submitButton = $('#groupChatSubmit');
    submitButton.disabled = false;
    submitButton.innerHTML = conversation ? '<i class="bx bx-save"></i> Save group' : '<i class="bx bx-group"></i> Create group';
    delete submitButton.dataset.original;
    $('#groupNameInput').value = conversation?.title || '';
    $('#groupDescriptionInput').value = conversation?.description || '';
    $('#groupMemberSearch').value = '';
    $('#groupRemoveLogoWrap').hidden = !conversation?.group_logo_url;
    $('#groupRemoveLogo').checked = false;
    setGroupLogoPreview(safeGroupLogo(conversation));
    renderGroupMemberPicker();
    $('#groupChatModal').hidden = false;
    document.body.style.overflow = 'hidden';
    window.setTimeout(() => $('#groupNameInput')?.focus(), 40);
  }

  function closeGroupModal() {
    $('#groupChatModal').hidden = true;
    document.body.style.overflow = '';
    state.editingGroupId = '';
    state.groupSelectedIds = new Set();
    state.groupAdminIds = new Set();
    $('#groupLogoInput').value = '';
    clearStatus($('#groupChatForm'));
  }

  function sharedContentItemMeta(item) {
    return `${item.sender?.display_name ? `Shared by ${escapeHtml(item.sender.display_name)} · ` : ''}${escapeHtml(formatDay(item.created_at))}`;
  }

  function renderSharedContent() {
    const host = $('#sharedContentGrid');
    if (!host || !state.sharedContent) return;
    const items = state.sharedContent[state.sharedContentTab] || [];
    $$('[data-content-tab]').forEach(button => {
      const active = button.dataset.contentTab === state.sharedContentTab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    if (!items.length) {
      const labels = {media: 'media', files: 'files', links: 'links'};
      host.innerHTML = `<div class="ops-empty shared-content-empty"><i class="bx ${state.sharedContentTab === 'media' ? 'bx-image' : state.sharedContentTab === 'files' ? 'bx-file' : 'bx-link'}"></i><h3>No ${labels[state.sharedContentTab]} yet</h3><p>Items shared after your most recent chat clear will appear here.</p></div>`;
      return;
    }
    if (state.sharedContentTab === 'media') {
      host.innerHTML = items.map(item => `<a class="shared-media-card" href="${escapeAttr(item.url)}" target="_blank" rel="noopener"><img src="${escapeAttr(item.preview_url)}" alt="${escapeAttr(item.name)}"><span><strong>${escapeHtml(item.name)}</strong><small>${sharedContentItemMeta(item)}</small></span></a>`).join('');
      return;
    }
    if (state.sharedContentTab === 'files') {
      host.innerHTML = items.map(item => `<a class="shared-file-card" href="${escapeAttr(item.url)}"><i class="bx ${item.mime === 'application/pdf' ? 'bxs-file-pdf' : 'bx-file'}"></i><span><strong>${escapeHtml(item.name)}</strong><small>${Math.max(1, Math.round(Number(item.size || 0) / 1024))} KB · ${sharedContentItemMeta(item)}</small></span><i class="bx bx-download"></i></a>`).join('');
      return;
    }
    host.innerHTML = items.map(item => `<a class="shared-link-card" href="${escapeAttr(item.url)}" target="_blank" rel="noopener"><i class="bx bx-link-external"></i><span><strong>${escapeHtml(item.url)}</strong><small>${sharedContentItemMeta(item)}</small></span><i class="bx bx-right-arrow-alt"></i></a>`).join('');
  }

  async function openSharedContent(conversation) {
    try {
      const result = await api(`/api/inbox/conversations/${encodeURIComponent(conversation.id)}/content`);
      state.sharedContent = result.content;
      state.sharedContentTab = 'media';
      $('#sharedContentTitle').textContent = `${result.conversation.title} shared content`;
      $('#sharedContentSubtitle').textContent = 'Media, files, and links visible in your current copy of this conversation.';
      Object.entries(result.content.counts || {}).forEach(([key, value]) => {
        const counter = $(`[data-content-count="${key}"]`);
        if (counter) counter.textContent = String(value);
      });
      renderSharedContent();
      $('#sharedContentModal').hidden = false;
      document.body.style.overflow = 'hidden';
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function closeSharedContent() {
    $('#sharedContentModal').hidden = true;
    document.body.style.overflow = '';
    state.sharedContent = null;
  }

  async function handleConversationAction(action, conversation) {
    closeConversationContextMenu();
    if (isAssistantConversation(conversation) && action === 'clear-assistant') {
      if (!window.confirm('Clear your SwapBot history and saved reminders?')) return;
      writeAssistantMessages([]);
      writeAssistantReminders([]);
      if (state.activeConversationId === AI_CONVERSATION_ID) await loadConversation(AI_CONVERSATION_ID, {scroll: true});
      await loadInbox({quiet: true});
      toast('AI history and reminders cleared.');
      return;
    }
    if (isAssistantConversation(conversation)) {
      if (action === 'details') {
        await openChatInfoModal(conversation);
      }
      return;
    }
    if (action === 'content') return openSharedContent(conversation);
    if (action === 'details') {
      await openChatInfoModal(conversation);
      return;
    }
    if (action === 'mute') {
      try {
        await api(`/api/inbox/conversations/${encodeURIComponent(conversation.id)}/mute`, {
          method: 'POST', body: {muted: !conversation.muted}
        });
        await loadInbox({quiet: true});
        if (state.activeConversationId === conversation.id) await loadConversation(conversation.id);
        toast(conversation.muted ? 'Conversation unmuted.' : 'Conversation muted.');
      } catch (error) {
        toast(error.message, 'error');
      }
      return;
    }
    if (action === 'clear') {
      if (!window.confirm(`Clear ${conversation.title} from your Inbox view? Other members will keep their copy, and new messages will still arrive.`)) return;
      try {
        const result = await api(`/api/inbox/conversations/${encodeURIComponent(conversation.id)}/history`, {method: 'DELETE'});
        await loadInbox({quiet: true});
        if (state.activeConversationId === conversation.id) await loadConversation(conversation.id, {scroll: true});
        toast(result.message);
      } catch (error) {
        toast(error.message, 'error');
      }
      return;
    }
    if (action === 'delete') {
      if (!window.confirm(`Delete ${conversation.title} from your Inbox? This removes the chat and its current history only for you. Other members keep their copy, and a future message can start the chat again.`)) return;
      try {
        const result = await api(`/api/inbox/conversations/${encodeURIComponent(conversation.id)}`, {method: 'DELETE'});
        if (state.activeConversationId === conversation.id) {
          state.activeConversationId = '';
          state.activeConversation = null;
          state.activeMessages = [];
          $('#chatActive')?.setAttribute('hidden', '');
          $('#chatEmpty')?.removeAttribute('hidden');
          $('#inboxWorkspace')?.classList.remove('chat-open');
        }
        await loadInbox({selectFirst: true, quiet: true});
        toast(result.message);
      } catch (error) {
        toast(error.message, 'error');
      }
      return;
    }
    if (action === 'schedule') {
      if (conversation.kind === 'direct') openQuickSchedule(conversation);
      else location.href = conversation.event ? `calendar.html?event=${encodeURIComponent(conversation.event.id)}` : 'calendar.html';
      return;
    }
    if (action === 'calendar') {
      location.href = conversation.event ? `calendar.html?event=${encodeURIComponent(conversation.event.id)}` : 'calendar.html';
      return;
    }
    if (action === 'report') {
      await openConversation(conversation.id);
      openReportModal();
      return;
    }
    if (action === 'edit-group') {
      ensureInboxContacts({quiet: true}).then(() => openGroupModal(conversation));
      return;
    }
    if (action === 'leave-group') {
      if (!window.confirm(`Leave ${conversation.title}? You will lose access to its messages and shared files.`)) return;
      try {
        const groupId = conversation.group_id || conversation.id;
        const leavePath = conversation.group_id
          ? `/api/community/groups/${encodeURIComponent(groupId)}/join`
          : `/api/inbox/groups/${encodeURIComponent(conversation.id)}/members/me`;
        await api(leavePath, {method: 'DELETE'});
        state.activeConversationId = '';
        state.activeConversation = null;
        state.activeMessages = [];
        $('#chatActive')?.setAttribute('hidden', '');
        $('#chatEmpty')?.removeAttribute('hidden');
        $('#inboxWorkspace')?.classList.remove('chat-open');
        if (state.inbox) state.inbox.conversations = state.inbox.conversations.filter(item => item.id !== conversation.id);
        renderConversationList();
        await loadInbox({selectFirst: true});
        toast('You left the group.');
      } catch (error) {
        toast(error.message, 'error');
      }
    }
  }

  async function handleConversationDetailsClick(event) {
    const conversation = state.activeConversation?.conversation;
    if (!conversation) return;
    const botFollowup = event.target.closest('[data-bot-followup]');
    if (botFollowup && isAssistantConversation(conversation)) {
      $('#messageBody').value = botFollowup.dataset.botFollowup;
      $('#messageComposer')?.requestSubmit();
      return;
    }
    if (conversation.kind === 'group') {
      if (event.target.closest('[data-group-content]')) await handleConversationAction('content', conversation);
      if (event.target.closest('[data-group-mute]')) await handleConversationAction('mute', conversation);
      if (event.target.closest('[data-group-edit]')) await handleConversationAction('edit-group', conversation);
      if (event.target.closest('[data-group-report]')) await handleConversationAction('report', conversation);
      if (event.target.closest('[data-group-leave]')) await handleConversationAction('leave-group', conversation);
      return;
    }
    const member = conversation?.members?.[0];
    if (!member) return;
    if (event.target.closest('[data-conversation-mute]')) {
      try {
        await api(`/api/inbox/conversations/${encodeURIComponent(conversation.id)}/mute`, {
          method: 'POST',
          body: {muted: !conversation.muted}
        });
        await loadConversation(conversation.id);
        toast(conversation.muted ? 'Conversation unmuted.' : 'Conversation muted.');
      } catch (error) {
        toast(error.message, 'error');
      }
    }
    if (event.target.closest('[data-conversation-block]')) {
      const blocked = conversation.blocked;
      if (!blocked && !window.confirm(
          `Block ${member.display_name}? Neither member will be able to send messages until you unblock them.`
          )) return;
      try {
        await api(`/api/inbox/users/${encodeURIComponent(member.id)}/block`, {
          method: blocked ? 'DELETE' : 'POST'
        });
        await loadConversation(conversation.id);
        toast(blocked ? 'Member unblocked.' : 'Member blocked.');
      } catch (error) {
        toast(error.message, 'error');
      }
    }
    if (event.target.closest('[data-conversation-report]')) {
      closeChatInfoModal();
      openReportModal();
    }
  }

  async function setupInbox() {
    showAuthenticatedApp('#inboxWorkspace');
    // Account-backed AI history is independent of the member inbox. Start it
    // in parallel so a slow history read cannot hold the chat list hostage.
    void loadAssistantHistory().then(() => {
      if (state.activeConversationId === AI_CONVERSATION_ID) {
        loadConversation(AI_CONVERSATION_ID, {quiet: true, scroll: false}).catch(() => {});
        checkAssistantReminders();
      }
    }).catch(() => {});
    await loadInbox({
      selectFirst: true
    });
    // Refresh the navbar badge after the inbox's initial conversation has been
    // read. This keeps the global chat count aligned with the sidebar state on
    // first load, including when the AI conversation is selected by default.
    window.dispatchEvent(new CustomEvent('swaplabs:inbox-read', {
      detail: {conversationId: state.activeConversationId || '', confirmed: true}
    }));
    checkAssistantReminders();
    syncAssistantRemindersToCalendar().then(changed => {
      if (changed && state.activeConversationId === AI_CONVERSATION_ID) {
        loadConversation(AI_CONVERSATION_ID, {quiet: true, scroll: false});
      }
    }).catch(() => {
      /* A later Inbox refresh can retry a browser-only reminder sync. */
    });
    state.assistantReminderPoll = window.setInterval(() => {
      if (!document.hidden) checkAssistantReminders();
    }, 30000);
    const inboxParameters = new URLSearchParams(location.search);
    const requestedConversation = inboxParameters.get('conversation');
    const requestedMember = inboxParameters.get('member');
    if (requestedConversation && state.inbox?.conversations.some(conversation => conversation.id ===
        requestedConversation)) {
      await openConversation(requestedConversation);
      history.replaceState({}, '', 'notifications.html');
    } else if (requestedMember && state.inbox?.contacts.some(member => member.id === requestedMember)) {
      try {
        const result = await api('/api/inbox/conversations', {
          method: 'POST',
          body: {
            target_user_id: requestedMember
          }
        });
        await loadInbox();
        await openConversation(result.conversation.id);
        history.replaceState({}, '', 'notifications.html');
      } catch (error) {
        toast(error.message, 'error');
      }
    } else if (requestedMember && state.inbox) {
      const contacts = await ensureInboxContacts({quiet: true});
      if (contacts.some(member => member.id === requestedMember)) {
        try {
          const result = await api('/api/inbox/conversations', {
            method: 'POST',
            body: {
              target_user_id: requestedMember
            }
          });
          await loadInbox();
          await openConversation(result.conversation.id);
          history.replaceState({}, '', 'notifications.html');
        } catch (error) {
          toast(error.message, 'error');
        }
      }
    }
    $('#conversationSearch')?.addEventListener('input', renderConversationList);
    $('#messageStream')?.addEventListener('click', async event => {
      const followup = event.target.closest('[data-bot-followup]');
      if (followup) {
        $('#messageBody').value = followup.dataset.botFollowup;
        $('#messageComposer')?.requestSubmit();
        return;
      }
      const redial = event.target.closest('[data-call-redial]');
      if (redial) {
        window.SwapLabsCalls?.start(redial.dataset.callRedial, redial.dataset.callMode || 'voice', state.activeConversationId);
        return;
      }
      const button = event.target.closest('[data-pin-message]');
      if (!button || !state.activeConversationId) return;
      try {
        const result = await api(`/api/inbox/conversations/${encodeURIComponent(state.activeConversationId)}/messages/${encodeURIComponent(button.dataset.pinMessage)}/pin`, {method:'PATCH', body:{pinned:button.dataset.pinned !== 'true'}});
        toast(result.notice);
        await loadConversation(state.activeConversationId);
      } catch (error) { toast(error.message, 'error'); }
    });
    $('#conversationList')?.addEventListener('click', event => {
      const menuButton = event.target.closest('[data-conversation-menu]');
      if (menuButton) {
        const conversation = state.inbox?.conversations.find(item => item.id === menuButton.dataset.conversationMenu);
        if (conversation) openConversationContextMenu(conversation, menuButton);
        return;
      }
      const button = event.target.closest('[data-conversation-id]');
      if (button) {
        closeConversationContextMenu();
        const conversation = state.inbox?.conversations.find(item => item.id === button.dataset.conversationId);
        if (conversation && state.activeConversationId === conversation.id) openChatInfoModal(conversation);
        else openConversation(button.dataset.conversationId);
      }
    });
    $('#conversationContextMenu')?.addEventListener('click', event => {
      const actionButton = event.target.closest('[data-conversation-action]');
      if (!actionButton) return;
      const conversation = state.inbox?.conversations.find(item => item.id === state.conversationMenuId);
      if (conversation) handleConversationAction(actionButton.dataset.conversationAction, conversation);
    });
    $('#inboxRefresh')?.addEventListener('click', () => loadInbox());
    $('#inboxComposeToggle')?.addEventListener('click', () => {
      const panel = $('#inboxNewChat');
      if (!panel) return;
      panel.hidden = !panel.hidden;
      if (!panel.hidden) {
        ensureInboxContacts({quiet: true}).then(() => $('#newChatMember')?.focus());
      }
    });
    $('#newChatButton')?.addEventListener('click', async () => {
      const target = $('#newChatMember')?.value;
      if (!target) return toast('Choose a member first.', 'error');
      try {
        const result = await api('/api/inbox/conversations', {
          method: 'POST',
          body: {
            target_user_id: target
          }
        });
        $('#inboxNewChat').hidden = true;
        await loadInbox();
        await openConversation(result.conversation.id);
      } catch (error) {
        toast(error.message, 'error');
      }
    });
    $('#newGroupButton')?.addEventListener('click', () => {
      ensureInboxContacts({quiet: true}).then(() => openGroupModal());
    });
    $('#groupMemberSearch')?.addEventListener('input', renderGroupMemberPicker);
    $('#groupMemberPicker')?.addEventListener('change', event => {
      const memberInput = event.target.closest('[data-group-member-id]');
      const adminInput = event.target.closest('[data-group-admin-id]');
      if (memberInput) {
        if (memberInput.checked) state.groupSelectedIds.add(memberInput.dataset.groupMemberId);
        else {
          state.groupSelectedIds.delete(memberInput.dataset.groupMemberId);
          state.groupAdminIds.delete(memberInput.dataset.groupMemberId);
        }
        renderGroupMemberPicker();
      }
      if (adminInput) {
        if (adminInput.checked) state.groupAdminIds.add(adminInput.dataset.groupAdminId);
        else state.groupAdminIds.delete(adminInput.dataset.groupAdminId);
        renderGroupMemberPicker();
      }
    });
    $('#groupLogoInput')?.addEventListener('change', event => {
      const file = event.target.files?.[0];
      if (file) setGroupLogoPreview(URL.createObjectURL(file));
      else setGroupLogoPreview(safeGroupLogo(groupConversationRecord()));
    });
    $$('[data-close-group-modal]').forEach(button => button.addEventListener('click', closeGroupModal));
    $('#groupChatForm')?.addEventListener('submit', async event => {
      event.preventDefault();
      clearStatus(event.currentTarget);
      if (state.groupSelectedIds.size < 2) {
        return setStatus(event.currentTarget, 'Choose at least two other people for this group.');
      }
      const editingId = state.editingGroupId;
      const form = new FormData();
      form.append('name', $('#groupNameInput').value.trim());
      form.append('description', $('#groupDescriptionInput').value.trim());
      form.append('participant_ids', JSON.stringify([...state.groupSelectedIds]));
      form.append('admin_ids', JSON.stringify([...state.groupAdminIds]));
      const logo = $('#groupLogoInput').files?.[0];
      if (logo) form.append('group_logo', logo);
      if ($('#groupRemoveLogo').checked) form.append('remove_logo', 'true');
      const button = $('#groupChatSubmit');
      setButtonLoading(button, true, editingId ? 'Saving' : 'Creating');
      try {
        const result = await api(editingId ? `/api/inbox/groups/${encodeURIComponent(editingId)}` : '/api/inbox/groups', {
          method: editingId ? 'PATCH' : 'POST', body: form
        });
        closeGroupModal();
        $('#inboxNewChat').hidden = true;
        await loadInbox({quiet: true});
        await openConversation(result.conversation.id);
        toast(editingId ? 'Group updated for every member.' : 'Group created and invitations delivered.');
      } catch (error) {
        setStatus(event.currentTarget, error.message);
        setButtonLoading(button, false);
      }
    });
    $('#followRequestStack')?.addEventListener('click', async event => {
      const accept = event.target.closest('[data-follow-accept]');
      const decline = event.target.closest('[data-follow-decline]');
      const button = accept || decline;
      if (!button) return;
      setButtonLoading(button, true, accept ? 'Accepting' : 'Deleting');
      try {
        await api(
          `/api/notifications/follow-requests/${encodeURIComponent(accept ? accept.dataset.followAccept : decline.dataset.followDecline)}${accept ? '/accept' : ''}`, {
            method: accept ? 'POST' : 'DELETE'
          });
        await loadInbox();
        toast(accept ? 'Follow request accepted.' : 'Follow request deleted.');
      } catch (error) {
        toast(error.message, 'error');
        setButtonLoading(button, false);
      }
    });
    const body = $('#messageBody');
    body?.addEventListener('input', () => {
      body.style.height = 'auto';
      body.style.height = `${Math.min(body.scrollHeight, 110)}px`;
      const now = Date.now();
      if (now - state.typingSentAt > 1800) {
        state.typingSentAt = now;
        sendTyping(true);
      }
      clearTimeout(state.typingTimer);
      state.typingTimer = setTimeout(() => sendTyping(false), 1800);
    });
    body?.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        $('#messageComposer')?.requestSubmit();
      }
    });
    $('#messageAttachment')?.addEventListener('change', event => {
      const file = event.target.files?.[0];
      const preview = $('#attachmentPreview');
      if (!preview) return;
      preview.hidden = !file;
      preview.innerHTML = file ?
        `<i class="bx bx-paperclip"></i> ${escapeHtml(file.name)} · ${Math.max(1, Math.round(file.size / 1024))} KB <button type="button" data-remove-attachment aria-label="Remove attachment"><i class="bx bx-x"></i></button>` :
        '';
    });
    $('#attachmentPreview')?.addEventListener('click', event => {
      if (!event.target.closest('[data-remove-attachment]')) return;
      $('#messageAttachment').value = '';
      $('#attachmentPreview').hidden = true;
      $('#attachmentPreview').innerHTML = '';
    });
    $('#messageComposer')?.addEventListener('submit', async event => {
      event.preventDefault();
      if (!state.activeConversationId) return;
      const button = $('button[type="submit"]', event.currentTarget);
      const form = new FormData();
      const messageBody = String($('#messageBody').value || '').trim();
      const file = $('#messageAttachment').files?.[0];
      if (!messageBody && !file) return;
      if (state.activeConversation?.conversation && isAssistantConversation(state.activeConversation.conversation)) {
        setButtonLoading(button, true, '');
        try {
          await sendAssistantMessage(messageBody || `I attached ${file.name}. What can you help me with?`);
          $('#messageBody').value = '';
          $('#messageBody').style.height = 'auto';
          $('#messageAttachment').value = '';
          $('#attachmentPreview').hidden = true;
          $('#attachmentPreview').innerHTML = '';
        } catch (error) {
          toast(error.message, 'error');
        } finally {
          setButtonLoading(button, false);
        }
        return;
      }
      form.append('body', messageBody);
      if (file) form.append('attachment', file);
      setButtonLoading(button, true, '');
      try {
        await api(`/api/inbox/conversations/${encodeURIComponent(state.activeConversationId)}/messages`, {
          method: 'POST',
          body: form
        });
        $('#messageBody').value = '';
        $('#messageBody').style.height = 'auto';
        $('#messageAttachment').value = '';
        $('#attachmentPreview').hidden = true;
        $('#attachmentPreview').innerHTML = '';
        await sendTyping(false);
        await loadConversation(state.activeConversationId, {
          scroll: true
        });
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        setButtonLoading(button, false);
      }
    });
    $('#detailsConversation')?.addEventListener('click', handleConversationDetailsClick);
    $('#chatInfoContent')?.addEventListener('click', handleConversationDetailsClick);
    const closeDetails = () => $('#inboxDetails')?.classList.remove('open');
    $('#inboxAccountTools')?.addEventListener('click', () => {
      $('#detailsConversation')?.setAttribute('hidden', '');
      $('#detailsDefault')?.removeAttribute('hidden');
      $('#inboxDetails')?.classList.add('open');
    });
    $('[data-chat-details-close]')?.addEventListener('click', closeDetails);
    $('#inboxDetailsBackdrop')?.addEventListener('click', closeDetails);
    $('#inboxBack')?.addEventListener('click', () => $('#inboxWorkspace')?.classList.remove('chat-open'));
    $('#chatHeading')?.addEventListener('click', () => openChatInfoModal());
    $('#chatInfoButton')?.addEventListener('click', () => openChatInfoModal());
    $('#chatVoiceCall')?.addEventListener('click', () => {
      const conversation = state.activeConversation?.conversation;
      const member = conversation?.kind === 'direct' ? conversation.members?.[0] : null;
      if (member) window.SwapLabsCalls?.start(member.id, 'voice', conversation.id);
    });
    $('#chatVideoCall')?.addEventListener('click', () => {
      const conversation = state.activeConversation?.conversation;
      const member = conversation?.kind === 'direct' ? conversation.members?.[0] : null;
      if (member) window.SwapLabsCalls?.start(member.id, 'video', conversation.id);
    });
    $('#chatSchedule')?.addEventListener('click', () => {
      const conversation = state.activeConversation?.conversation;
      if (conversation?.kind === 'direct') openQuickSchedule(conversation);
      else if (conversation?.event) location.href = `calendar.html?event=${encodeURIComponent(conversation.event.id)}`;
      else location.href = 'calendar.html';
    });
    $$('[data-close-chat-info]').forEach(button => button.addEventListener('click', closeChatInfoModal));
    $$('[data-close-modal]').forEach(button => button.addEventListener('click', closeReportModal));
    $$('[data-close-quick-schedule]').forEach(button => button.addEventListener('click', closeQuickSchedule));
    $('#quickScheduleForm')?.addEventListener('submit', submitQuickSchedule);
    $('#reportMember')?.addEventListener('change', refreshReportMessageOptions);
    $$('[data-close-content-modal]').forEach(button => button.addEventListener('click', closeSharedContent));
    $('.shared-content-tabs')?.addEventListener('click', event => {
      const button = event.target.closest('[data-content-tab]');
      if (!button) return;
      state.sharedContentTab = button.dataset.contentTab;
      renderSharedContent();
    });
    $('#reportForm')?.addEventListener('submit', async event => {
      event.preventDefault();
      clearStatus(event.currentTarget);
      const conversation = state.activeConversation?.conversation;
      if (!conversation) return;
      const fields = new FormData(event.currentTarget);
      const button = $('button[type="submit"]', event.currentTarget);
      setButtonLoading(button, true, 'Submitting');
      try {
        await api('/api/inbox/reports', {
          method: 'POST',
          body: {
            conversation_id: conversation.id,
            reported_user_id: fields.get('reported_user_id'),
            category: fields.get('category'),
            message_id: fields.get('message_id'),
            details: fields.get('details')
          }
        });
        closeReportModal();
        toast('Report securely sent to the administration team.');
      } catch (error) {
        setStatus(event.currentTarget, error.message);
        setButtonLoading(button, false);
      }
    });
    document.addEventListener('click', event => {
      if (!event.target.closest('#conversationContextMenu, [data-conversation-menu]')) closeConversationContextMenu();
    });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      closeConversationContextMenu();
      if (!$('#chatInfoModal')?.hidden) closeChatInfoModal();
      if (!$('#groupChatModal')?.hidden) closeGroupModal();
      if (!$('#quickScheduleModal')?.hidden) closeQuickSchedule();
      if (!$('#sharedContentModal')?.hidden) closeSharedContent();
    });
    window.addEventListener('resize', closeConversationContextMenu);
    state.inboxPoll = setInterval(() => {
      if (!document.hidden && document.visibilityState === 'visible') loadInbox({
        quiet: true
      });
    }, 15000);
    state.chatPoll = setInterval(() => {
      if (!document.hidden && document.visibilityState === 'visible' && state.activeConversationId && !state.conversationRequests.has(state.activeConversationId)) loadConversation(state.activeConversationId, {
        quiet: true
      });
    }, 7000);
  }

  /* Calendar */
  const timezoneFallback = ['UTC', 'Africa/Cairo', 'Africa/Johannesburg', 'America/Chicago', 'America/Los_Angeles',
    'America/New_York', 'America/Sao_Paulo', 'Asia/Dubai', 'Asia/Hong_Kong', 'Asia/Kolkata', 'Asia/Singapore',
    'Asia/Tokyo', 'Australia/Sydney', 'Europe/Berlin', 'Europe/London', 'Europe/Madrid', 'Europe/Paris',
    'Pacific/Auckland'
  ];
  const timezones = (() => {
    try {
      return ['UTC', ...Intl.supportedValuesOf('timeZone').filter(zone => zone !== 'UTC')];
    } catch (_error) {
      return timezoneFallback;
    }
  })();
  const safeTimezone = value => timezones.includes(String(value || '')) ? String(value) : 'UTC';
  const timezoneOptions = selected => timezones.map(zone =>
    `<option value="${escapeAttr(zone)}" ${zone === safeTimezone(selected) ? 'selected' : ''}>${escapeHtml(zone.replaceAll('_',' '))}</option>`
    ).join('');
  const inTimezoneInput = (value, zone) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: safeTimezone(zone),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(date).filter(item => item.type !== 'literal').map(item => [item.type, item.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  };
  const neutralLocalMilliseconds = value => {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(value || ''));
    if (!match) return NaN;
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
  };
  const neutralLocalInput = milliseconds => {
    const date = new Date(milliseconds);
    if (Number.isNaN(date.getTime())) return '';
    const pad = value => String(value).padStart(2, '0');
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
  };
  function syncCalendarEndTime(form) {
    if (!form?.elements.starts_at || !form.elements.ends_at) return;
    const start = neutralLocalMilliseconds(form.elements.starts_at.value);
    const duration = Number(form.elements.duration_minutes?.value || 60);
    form.elements.ends_at.value = Number.isNaN(start) ? '' : neutralLocalInput(start + Math.max(15, duration) * 60000);
  }
  function setDurationFromLocalRange(form) {
    if (!form?.elements.duration_minutes || !form.elements.starts_at || !form.elements.ends_at) return;
    const start = neutralLocalMilliseconds(form.elements.starts_at.value);
    const end = neutralLocalMilliseconds(form.elements.ends_at.value);
    if (Number.isNaN(start) || Number.isNaN(end)) return;
    const minutes = Math.max(15, Math.round((end - start) / 60000));
    const options = [...form.elements.duration_minutes.options].map(option => Number(option.value));
    const chosen = options.reduce((closest, option) => Math.abs(option - minutes) < Math.abs(closest - minutes) ? option : closest, options[0] || 60);
    form.elements.duration_minutes.value = String(chosen);
  }
  const compactUtc = value => new Date(value).toISOString().replace(/[-:]/g, '').replace('.000', '');
  const googleCalendarUrl = event =>
    `https://calendar.google.com/calendar/render?${new URLSearchParams({action:'TEMPLATE',text:event.title,dates:`${compactUtc(event.starts_at)}/${compactUtc(event.ends_at)}`,details:event.description || '',location:event.meeting_url || event.location || ''})}`;
  const outlookCalendarUrl = event =>
    `https://outlook.live.com/calendar/0/deeplink/compose?${new URLSearchParams({path:'/calendar/action/compose',rru:'addevent',subject:event.title,startdt:new Date(event.starts_at).toISOString(),enddt:new Date(event.ends_at).toISOString(),body:event.description || '',location:event.meeting_url || event.location || ''})}`;

  function updateHeroClock(zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC') {
    zone = safeTimezone(zone);
    const now = new Date();
    const dateParts = new Intl.DateTimeFormat(undefined, {
      timeZone: zone,
      month: 'long',
      day: 'numeric',
      weekday: 'long'
    }).formatToParts(now);
    const lookup = type => dateParts.find(item => item.type === type)?.value || '';
    if ($('#calendarHeroMonth')) $('#calendarHeroMonth').textContent = lookup('month');
    if ($('#calendarHeroDay')) $('#calendarHeroDay').textContent = lookup('day');
    if ($('#calendarHeroWeekday')) $('#calendarHeroWeekday').textContent = lookup('weekday');
    if ($('#calendarHeroTime')) $('#calendarHeroTime').textContent = new Intl.DateTimeFormat(undefined, {
      timeZone: zone,
      hour: 'numeric',
      minute: '2-digit'
    }).format(now);
    if ($('#calendarHeroZone')) $('#calendarHeroZone').textContent = zone.replaceAll('_', ' ');
  }

  function setCalendarTab(name, updateUrl = true) {
    const root = document.querySelector('[data-operations-page="calendar"]');
    if (!root) return;
    const tab = name === 'schedules' ? 'schedules' : 'calendar';
    state.calendarTab = tab;
    $$('[data-calendar-tab]', root).forEach(button => {
      const active = button.dataset.calendarTab === tab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    });
    $$('[data-calendar-panel]', root).forEach(panel => {
      const active = panel.dataset.calendarPanel === tab;
      panel.hidden = !active;
      panel.setAttribute('aria-hidden', String(!active));
    });
    if (updateUrl) {
      const url = new URL(window.location.href);
      url.hash = tab;
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
  }

  function setupCalendarTabs() {
    const root = document.querySelector('[data-operations-page="calendar"]');
    if (!root) return;
    const buttons = $$('[data-calendar-tab]', root);
    if (!buttons.length) return;
    buttons.forEach(button => button.addEventListener('click', () => setCalendarTab(button.dataset.calendarTab)));
    window.addEventListener('hashchange', () => setCalendarTab(location.hash === '#schedules' ? 'schedules' : 'calendar', false));
    const queryView = new URLSearchParams(location.search).get('view');
    setCalendarTab(location.hash === '#schedules' || location.hash === '#availability' || queryView === 'schedules' ? 'schedules' : 'calendar', false);
  }

  function renderCalendarStats() {
    const events = state.calendar?.events || [];
    const now = Date.now();
    const upcoming = events.filter(event => event.status === 'scheduled' && new Date(event.ends_at).getTime() >= now);
    $('#calendarUpcoming').textContent = String(upcoming.length);
    $('#calendarParticipants').textContent = String(new Set(upcoming.flatMap(event => event.participant_ids || []))
      .size);
    $('#calendarReminders').textContent = String(upcoming.reduce((sum, event) => sum + (event.reminders_minutes || [])
      .length, 0));
    const zone = state.calendar?.availability?.timezone || state.user?.profile?.timezone || 'UTC';
    $('#calendarTimezoneShort').textContent = zone.split('/').at(-1).replaceAll('_', ' ');
  }

  const calendarDayStart = value => {
    const date = new Date(value);
    date.setHours(0, 0, 0, 0);
    return date;
  };
  const calendarAddDays = (value, amount) => {
    const date = new Date(value);
    date.setDate(date.getDate() + amount);
    return date;
  };
  const calendarWeekStart = value => {
    const date = calendarDayStart(value);
    const weekday = date.getDay();
    return calendarAddDays(date, weekday === 0 ? -6 : 1 - weekday);
  };
  const sameCalendarDay = (first, second) => calendarDayStart(first).getTime() === calendarDayStart(second).getTime();
  const calendarEventsForDay = day => (state.calendar?.events || []).filter(item => item.status !== 'cancelled' && sameCalendarDay(new Date(item.starts_at), day));
  const calendarDateKey = value => {
    const date = new Date(value);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  const calendarHeader = day => `<span>${new Intl.DateTimeFormat(undefined,{weekday:'short'}).format(day)}</span><strong>${day.getDate()}</strong><small>${new Intl.DateTimeFormat(undefined,{month:'short'}).format(day)}</small>`;

  function calendarEventPill(event, compact = false) {
    const isHost = event.host_id === state.user.id;
    return `<button class="calendar-grid-event ${isHost ? 'host' : 'invited'} ${event.all_day ? 'all-day' : ''}" type="button" data-grid-event="${escapeAttr(event.id)}" title="${escapeAttr(event.title)} · ${escapeAttr(event.all_day ? 'All day' : formatShortTime(event.starts_at))}"><strong>${compact || event.all_day ? '' : `${escapeHtml(formatShortTime(event.starts_at))} `}${escapeHtml(event.title)}</strong>${compact || event.all_day ? '' : `<span>${escapeHtml(event.participants?.length || 0)} invited</span>`}${!compact && isHost && !event.all_day ? `<span class="calendar-resize-handle" data-resize-event="${escapeAttr(event.id)}" title="Drag to resize" aria-label="Resize ${escapeAttr(event.title)}"></span>` : ''}</button>`;
  }

  function renderMonthCalendar() {
    const cursor = state.calendarCursor;
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const gridStart = calendarWeekStart(first);
    const today = new Date();
    const weekdays = Array.from({length: 7}, (_, index) => calendarAddDays(gridStart, index));
    const cells = Array.from({length: 42}, (_, index) => {
      const day = calendarAddDays(gridStart, index);
      const events = calendarEventsForDay(day);
      return `<div class="calendar-month-cell ${day.getMonth() !== cursor.getMonth() ? 'outside' : ''} ${sameCalendarDay(day,today) ? 'today' : ''}" role="button" tabindex="0" data-calendar-date="${calendarDateKey(day)}"><span class="calendar-month-number">${day.getDate()}</span><span class="calendar-month-events">${events.slice(0,3).map(event => calendarEventPill(event,true)).join('')}${events.length > 3 ? `<small>+${events.length - 3} more</small>` : ''}</span></div>`;
    }).join('');
    return `<div class="calendar-month-grid"><div class="calendar-month-weekdays">${weekdays.map(day => `<span>${new Intl.DateTimeFormat(undefined,{weekday:'short'}).format(day)}</span>`).join('')}</div><div class="calendar-month-days">${cells}</div></div>`;
  }

  function renderTimeCalendar(dayCount) {
    const start = dayCount === 1 ? calendarDayStart(state.calendarCursor) : calendarWeekStart(state.calendarCursor);
    const days = Array.from({length: dayCount}, (_, index) => calendarAddDays(start, index));
    const hours = Array.from({length: 15}, (_, index) => index + 7);
    const today = new Date();
    const header = `<button class="calendar-time-corner" type="button" data-calendar-now><span class="calendar-mini-today">Today</span><i class="bx bx-plus"></i></button>${days.map(day => `<button class="calendar-time-day-head ${sameCalendarDay(day,today) ? 'today' : ''}" type="button" data-calendar-date="${calendarDateKey(day)}" aria-label="Add event on ${escapeAttr(new Intl.DateTimeFormat(undefined,{weekday:'long',month:'long',day:'numeric'}).format(day))}">${calendarHeader(day)}</button>`).join('')}`;
    const allDay = `<div class="calendar-all-day-label">All day</div>${days.map(day => `<div class="calendar-all-day-slot" data-calendar-date="${calendarDateKey(day)}">${calendarEventsForDay(day).filter(item => item.all_day).map(event => calendarEventPill(event)).join('') || '<span>—</span>'}</div>`).join('')}`;
    const rows = hours.map(hour => {
      const labelDate = new Date(2000, 0, 1, hour);
      const label = new Intl.DateTimeFormat(undefined,{hour:'numeric'}).format(labelDate);
      return `<div class="calendar-hour-label">${escapeHtml(label)}</div>${days.map(day => {
        const slot = new Date(day);
        slot.setHours(hour, 0, 0, 0);
        const events = calendarEventsForDay(day).filter(event => !event.all_day && new Date(event.starts_at).getHours() === hour);
        const nowMarker = sameCalendarDay(day, today) && today.getHours() === hour ? `<span class="calendar-now-line" style="--now-minute:${today.getMinutes()}"><b>${escapeHtml(new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'}).format(today))}</b></span>` : '';
        return `<div class="calendar-hour-slot" role="button" tabindex="0" data-calendar-slot="${escapeAttr(slot.toISOString())}" aria-label="Add event ${escapeAttr(formatDate(slot))}"><span class="calendar-slot-add"><i class="bx bx-plus"></i></span>${nowMarker}${events.map(event => calendarEventPill(event)).join('')}</div>`;
      }).join('')}`;
    }).join('');
    return `<div class="calendar-time-grid" style="--calendar-days:${dayCount}">${header}${allDay}${rows}</div>`;
  }

  function renderCalendarBoard() {
    const host = $('#calendarBoard');
    if (!host || !state.calendar) return;
    const cursor = state.calendarCursor;
    if (state.calendarView === 'month') {
      $('#calendarPeriodLabel').textContent = new Intl.DateTimeFormat(undefined,{month:'long',year:'numeric'}).format(cursor);
      host.innerHTML = renderMonthCalendar();
    } else if (state.calendarView === 'day') {
      $('#calendarPeriodLabel').textContent = new Intl.DateTimeFormat(undefined,{weekday:'long',month:'long',day:'numeric',year:'numeric'}).format(cursor);
      host.innerHTML = renderTimeCalendar(1);
    } else {
      const start = calendarWeekStart(cursor), end = calendarAddDays(start, 6);
      $('#calendarPeriodLabel').textContent = `${new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric'}).format(start)} – ${new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',year:'numeric'}).format(end)}`;
      host.innerHTML = renderTimeCalendar(7);
    }
    $$('[data-calendar-view]', $('#calendarViewSwitch')).forEach(button => button.classList.toggle('active', button.dataset.calendarView === state.calendarView));
  }

  function prepareCalendarFormAt(value) {
    setCalendarTab('schedules');
    resetCalendarForm();
    const form = $('#calendarEventForm');
    if (!form) return;
    const zone = form.elements.timezone.value || state.calendar?.availability?.timezone || 'UTC';
    const start = new Date(value);
    if (Number.isNaN(start.getTime())) return;
    if (start.getHours() === 0 && start.getMinutes() === 0) start.setHours(9, 0, 0, 0);
    const end = new Date(start.getTime() + 3600000);
    form.elements.starts_at.value = inTimezoneInput(start, zone);
    form.elements.ends_at.value = inTimezoneInput(end, zone);
    form.elements.duration_minutes.value = '60';
    syncCalendarEndTime(form);
    form.elements.title.value = `${new Intl.DateTimeFormat(undefined,{weekday:'short'}).format(start)} ${new Intl.DateTimeFormat(undefined,{hour:'numeric'}).format(start)} session`;
    $('#calendarFormTitle').textContent = `New event · ${new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',hour:'numeric'}).format(start)}`;
    form.scrollIntoView({behavior:'smooth', block:'start'});
    setTimeout(() => form.elements.title.focus(), 350);
  }

  function applySchedulePreset(preset) {
    const form = $('#calendarEventForm');
    if (!form) return;
    const zone = form.elements.timezone.value || state.calendar?.availability?.timezone || 'UTC';
    const date = new Date();
    if (preset === 'tomorrow') {
      date.setDate(date.getDate() + 1);
      date.setHours(9, 0, 0, 0);
    } else if (preset === 'this-evening') {
      if (date.getHours() >= 18) date.setDate(date.getDate() + 1);
      date.setHours(18, 0, 0, 0);
    } else if (preset === 'next-week') {
      date.setDate(date.getDate() + 7);
      date.setHours(9, 0, 0, 0);
    } else return;
    form.elements.starts_at.value = inTimezoneInput(date, zone);
    form.elements.duration_minutes.value = '60';
    syncCalendarEndTime(form);
    form.elements.starts_at.focus();
  }

  function showQuickEventPopover(value, anchor) {
    document.querySelector('.calendar-quick-popover')?.remove();
    const start = new Date(value);
    if (Number.isNaN(start.getTime())) return;
    if (start.getHours() === 0 && start.getMinutes() === 0) start.setHours(9);
    const end = new Date(start.getTime() + 3600000);
    const title = `${new Intl.DateTimeFormat(undefined,{weekday:'short'}).format(start)} ${new Intl.DateTimeFormat(undefined,{hour:'numeric'}).format(start)} session`;
    const popover = document.createElement('form');
    popover.className = 'calendar-quick-popover';
    popover.innerHTML = `<div><strong>Quick event</strong><button type="button" data-quick-close aria-label="Close"><i class="bx bx-x"></i></button></div><small>${escapeHtml(new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(start))}</small><input name="title" maxlength="160" required value="${escapeAttr(title)}" aria-label="Event title"><label><input name="all_day" type="checkbox"> All day</label><div><button class="btn btn-sm" type="button" data-quick-more>More details</button><button class="btn btn-primary btn-sm" type="submit">Save</button></div><span data-quick-status></span>`;
    document.body.appendChild(popover);
    const rect = anchor?.getBoundingClientRect?.() || {left: innerWidth / 2, bottom: innerHeight / 2};
    popover.style.left = `${Math.max(12, Math.min(innerWidth - 332, rect.left))}px`;
    popover.style.top = `${Math.max(12, Math.min(innerHeight - 250, rect.bottom + 8))}px`;
    popover.querySelector('[data-quick-close]').addEventListener('click', () => popover.remove());
    popover.querySelector('[data-quick-more]').addEventListener('click', () => { popover.remove(); prepareCalendarFormAt(start); });
    popover.addEventListener('submit', async event => {
      event.preventDefault();
      const button = popover.querySelector('[type="submit"]');
      button.disabled = true;
      button.textContent = 'Saving…';
      try {
        await api('/api/calendar/events', {method:'POST', body:{title:popover.elements.title.value, description:'', starts_at:inTimezoneInput(start, state.calendar.availability.timezone), ends_at:inTimezoneInput(end, state.calendar.availability.timezone), timezone:state.calendar.availability.timezone, participant_ids:[], location:'', meeting_url:'', reminders_minutes:[60], recurrence:'none', recurrence_count:1, all_day:popover.elements.all_day.checked}});
        popover.remove();
        await syncCalendarEvents();
        toast('Event saved to your calendar.');
      } catch (error) {
        popover.querySelector('[data-quick-status]').textContent = error.message;
        button.disabled = false;
        button.textContent = 'Save';
      }
    });
    popover.elements.title.select();
  }

  function startCalendarResize(handle, event) {
    const item = state.calendar.events.find(entry => entry.id === handle.dataset.resizeEvent);
    if (!item) return;
    event.preventDefault();
    event.stopPropagation();
    state.calendarResize = {event:item, startY:event.clientY, originalEnd:new Date(item.ends_at), previewEnd:new Date(item.ends_at)};
    handle.closest('.calendar-grid-event')?.classList.add('is-resizing');
  }

  function updateCalendarResize(event) {
    if (!state.calendarResize) return;
    const steps = Math.round((event.clientY - state.calendarResize.startY) / 18);
    const start = new Date(state.calendarResize.event.starts_at);
    const next = new Date(state.calendarResize.originalEnd.getTime() + steps * 15 * 60000);
    state.calendarResize.previewEnd = next <= start ? new Date(start.getTime() + 15 * 60000) : next;
    const pill = $(`[data-grid-event="${CSS.escape(state.calendarResize.event.id)}"]`);
    if (pill) pill.title = `Ends ${new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'}).format(state.calendarResize.previewEnd)}`;
  }

  async function finishCalendarResize() {
    const resize = state.calendarResize;
    if (!resize) return;
    state.calendarResize = null;
    try {
      await api(`/api/calendar/events/${encodeURIComponent(resize.event.id)}`, {method:'PATCH', body:{ends_at:inTimezoneInput(resize.previewEnd, resize.event.timezone)}});
      await syncCalendarEvents();
      toast('Event duration updated.');
    } catch (error) {
      toast(error.message, 'error');
      renderCalendarBoard();
    }
  }

  function applyCalendarTemplate(template) {
    setCalendarTab('schedules');
    const form = $('#calendarEventForm');
    if (!form) return;
    const templates = {
      meeting: {
        title: 'Team meeting',
        description: 'A short working session to align on goals and next steps.',
        recurrence: 'weekly',
        recurrence_count: 4
      },
      workshop: {
        title: 'Workshop session',
        description: 'A hands-on workshop with prep notes, live discussion, and follow-up.',
        recurrence: 'none',
        recurrence_count: 1
      },
      'one-to-one': {
        title: '1:1 catch-up',
        description: 'A focused one-to-one conversation with decisions and next actions.',
        recurrence: 'weekly',
        recurrence_count: 4
      },
      swap: {
        title: 'Skill swap',
        description: 'A reciprocal exchange of skills and feedback.',
        recurrence: 'weekly',
        recurrence_count: 2
      },
      review: {
        title: 'Portfolio review',
        description: 'Review portfolio work, give feedback, and set next actions.',
        recurrence: 'none',
        recurrence_count: 1
      }
    };
    const chosen = templates[template];
    if (!chosen) return;
    form.elements.title.value = chosen.title;
    form.elements.description.value = chosen.description;
    form.elements.recurrence.value = chosen.recurrence;
    form.elements.recurrence_count.value = chosen.recurrence_count;
    form.scrollIntoView({behavior: 'smooth', block: 'start'});
    form.elements.title.focus();
  }

  async function duplicateCalendarEvent(eventId) {
    try {
      await api(`/api/calendar/events/${encodeURIComponent(eventId)}/duplicate`, { method: 'POST' });
      await loadCalendar();
      toast('Event duplicated.');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function slotDateFromPointer(slot, event) {
    const start = new Date(slot.dataset.calendarSlot);
    if (Number.isNaN(start.getTime()) || !event || typeof event.clientY !== 'number') return start;
    const rect = slot.getBoundingClientRect();
    const ratio = rect.height ? Math.max(0, Math.min(0.999, (event.clientY - rect.top) / rect.height)) : 0;
    const minutes = Math.min(45, Math.max(0, Math.floor(ratio * 4) * 15));
    start.setMinutes(minutes, 0, 0);
    return start;
  }

  function startCalendarDrag(slot, event) {
    if (!slot) return;
    state.calendarDrag = {
      start: new Date(slot.dataset.calendarSlot),
      current: new Date(slot.dataset.calendarSlot),
      pointerId: event.pointerId,
      origin: slot
    };
    slot.setPointerCapture?.(event.pointerId);
    slot.classList.add('calendar-drag-origin');
  }

  function updateCalendarDrag(slot) {
    if (!state.calendarDrag || !slot) return;
    state.calendarDrag.current = new Date(slot.dataset.calendarSlot);
    $$('.calendar-hour-slot.is-dragging').forEach(item => item.classList.remove('is-dragging'));
    const start = new Date(state.calendarDrag.start);
    const current = new Date(state.calendarDrag.current);
    const cells = $$('.calendar-hour-slot[data-calendar-slot]');
    const low = Math.min(start.getTime(), current.getTime());
    const high = Math.max(start.getTime(), current.getTime());
    cells.forEach(cell => {
      const value = new Date(cell.dataset.calendarSlot).getTime();
      if (value >= low && value <= high) cell.classList.add('is-dragging');
    });
  }

  function finishCalendarDrag() {
    if (!state.calendarDrag) return;
    const {start, current} = state.calendarDrag;
    const low = new Date(Math.min(start.getTime(), current.getTime()));
    const high = new Date(Math.max(start.getTime(), current.getTime()));
    low.setMinutes(low.getMinutes() - (low.getMinutes() % 15), 0, 0);
    high.setMinutes(high.getMinutes() - (high.getMinutes() % 15), 0, 0);
    if (high.getTime() === low.getTime()) high.setMinutes(high.getMinutes() + 60);
    const form = $('#calendarEventForm');
    form.elements.starts_at.value = inTimezoneInput(low, form.elements.timezone.value);
    form.elements.ends_at.value = inTimezoneInput(new Date(high.getTime() + 15 * 60000), form.elements.timezone.value);
    setDurationFromLocalRange(form);
    $('#calendarFormTitle').textContent = `New event · ${new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric'}).format(low)}`;
    $$('.calendar-hour-slot').forEach(item => item.classList.remove('is-dragging', 'calendar-drag-origin'));
    state.calendarDrag = null;
    state.calendarDragJustFinished = Date.now();
    form.scrollIntoView({behavior:'smooth', block:'start'});
  }

  function filteredEvents() {
    const events = state.calendar?.events || [];
    const now = Date.now();
    if (state.calendarFilter === 'cancelled') return events.filter(event => event.status === 'cancelled');
    if (state.calendarFilter === 'completed') return events.filter(event => event.status === 'completed');
    if (state.calendarFilter === 'unconfirmed') return events.filter(event => event.status === 'scheduled' && new Date(event.ends_at) <= new Date());
    if (state.calendarFilter === 'upcoming') return events.filter(event => event.status === 'scheduled' && new Date(
      event.ends_at).getTime() >= now);
    return events;
  }

  function renderCalendarEvents() {
    const events = filteredEvents();
    const host = $('#calendarEventList');
    if (!host) return;
    const uniqueDates = [...new Set(events.slice(0, 12).map(event => new Date(event.starts_at).toDateString()))];
    $('#calendarDateRail').innerHTML = uniqueDates.length ? uniqueDates.map((date, index) => {
      const parsed = new Date(date);
      return `<button class="date-rail-item ${index === 0 ? 'active' : ''}" type="button" data-agenda-date="${calendarDateKey(parsed)}" aria-label="Open ${escapeAttr(new Intl.DateTimeFormat(undefined,{weekday:'long',month:'long',day:'numeric'}).format(parsed))}"><span>${new Intl.DateTimeFormat(undefined,{weekday:'short'}).format(parsed)}</span><strong>${parsed.getDate()}</strong><small>${new Intl.DateTimeFormat(undefined,{month:'short'}).format(parsed)}</small></button>`;
    }).join('') : '<span class="ops-muted">No dates in this view.</span>';
    host.innerHTML = events.length ? events.map(event => {
        const start = new Date(event.starts_at);
        const status = event.status;
        const isHost = event.host_id === state.user.id;
        const participantCards = (event.participants || []).map(member =>
          `<span class="event-person-chip">${avatarHtml(member)}<span><strong>${escapeHtml(member.display_name)}</strong><small>@${escapeHtml(member.username)}</small></span></span>`
        ).join('');
        const roomParameter = event.video_room_id ? `room=${encodeURIComponent(event.video_room_id)}` : `event=${encodeURIComponent(event.id)}`;
        const inboxLink = event.conversation_id ?
          `<a class="btn btn-sm" href="notifications.html?conversation=${encodeURIComponent(event.conversation_id)}"><i class="bx bx-message-square-dots"></i> Open meeting thread</a>` : '';
        const progressSummary = event.progress_summary || {};
        const sessionFee = Number(progressSummary.session_cost_credits || 1);
        const transferType = progressSummary.credit_transfer_type || '';
        const settledCopy = transferType === 'mutual' ? 'Mutual exchange · no credits transferred' : transferType === 'one_way' ? '1 credit transferred from learner to teacher' : `${sessionFee}-credit exchange fee deducted`;
        const progressStatus = status === 'completed' && event.viewer_is_member ?
          (progressSummary.status === 'settled' ? `<span class="session-credit-status ready"><i class="bx bx-check-circle"></i> ${settledCopy}</span>` : event.viewer_progress_report ? `<span class="session-credit-status pending"><i class="bx bx-time-five"></i> Your report is saved · ${Number(progressSummary.submitted_count || 0)}/${Number(progressSummary.required_count || 2)} reports complete</span>` : `<span class="session-credit-status pending"><i class="bx bx-error-circle"></i> Your progress report is required before credits settle</span>`) : '';
        const progressAction = status === 'completed' && event.viewer_can_report_progress ? `<button class="btn ${event.viewer_progress_report ? 'btn-sm' : 'btn-primary btn-sm'}" type="button" data-event-progress="${escapeAttr(event.id)}"><i class="bx bx-line-chart"></i> ${event.viewer_progress_report ? 'Edit progress report' : 'Complete progress report'}</button>` : '';
        return `<article class="calendar-event-card ${escapeAttr(status)}" data-calendar-event-id="${escapeAttr(event.id)}">
        <div class="event-time"><strong>${escapeHtml(formatShortTime(event.starts_at))}</strong><span>${escapeHtml(formatDay(event.starts_at))}</span></div>
        <div class="event-main"><div class="event-title-line"><span class="event-role-pill ${isHost ? 'host' : 'invited'}"><i class="bx ${isHost ? 'bx-broadcast' : 'bx-user-check'}"></i>${isHost ? 'You host' : 'You are invited'}</span><h3>${escapeHtml(event.title)} ${status === 'cancelled' ? '<span class="ledger-type payment">Cancelled</span>' : ''}</h3></div><p>${escapeHtml(event.description || 'No session description was added.')}</p><div class="event-meta"><span><i class="bx bx-time"></i>${Math.round((new Date(event.ends_at)-start)/60000)} minutes</span><span><i class="bx bx-globe"></i>${escapeHtml(event.timezone)}</span><span><i class="bx bx-map"></i>${escapeHtml(event.meeting_url ? 'Online meeting' : event.location || 'Location not set')}</span><span><i class="bx bx-group"></i>${event.participants?.length || 0} invited</span></div>
        <div class="event-people-panel"><div class="event-host-summary"><span>Host</span><div>${avatarHtml(event.host)}<strong>${escapeHtml(event.host?.display_name || 'SwapLabs host')}</strong></div></div><div class="event-participant-summary"><span>Invited members</span><div class="event-person-chips">${participantCards || '<small>No additional members invited.</small>'}</div></div></div>
        ${event.meeting_url ? `<a class="event-meeting-link" href="${escapeAttr(event.meeting_url)}" target="_blank" rel="noopener"><i class="bx bx-link-external"></i><span><strong>External meeting link</strong><small>${escapeHtml(event.meeting_url)}</small></span></a>` : ''}
        <div class="event-video-action">${status !== 'cancelled' ? `<a class="btn btn-primary btn-sm" href="video-room.html?${roomParameter}"><i class="bx bx-video"></i> ${event.video_room_id ? 'Open live room' : 'Create live room'}</a>${event.video_invite_token ? `<button class="btn btn-sm" type="button" data-copy-meeting-invite="${escapeAttr(event.video_invite_token)}"><i class="bx bx-link"></i> Copy invite link</button>` : ''}` : ''}${inboxLink}<span><i class="bx bx-shield-quarter"></i> Shared details and attendance enabled</span></div></div>
        <div class="event-actions">${status === 'completed' ? '<span class="ledger-type">Completion confirmed</span>' : ''}${progressStatus}${progressAction}${status === 'completed' && event.viewer_can_rate ? `<button class="btn btn-primary btn-sm" type="button" data-event-rate="${escapeAttr(event.id)}"><i class="bx bx-star"></i> Rate session</button>` : ''}${status === 'completed' && event.viewer_rating ? `<span class="ledger-type"><i class="bx bxs-star"></i> Rated ${escapeHtml(event.viewer_rating.rating)}/5</span>` : ''}${status === 'completed' && event.rating_summary?.status === 'under_review' ? '<span class="ledger-type payment">Points pending review</span>' : ''}${event.viewer_can_complete ? `<button class="btn btn-sm" type="button" data-event-complete="${escapeAttr(event.id)}">Confirm completed</button>` : ''}${event.viewer_can_edit && status !== 'cancelled' ? `<button class="ops-icon-button" type="button" data-event-edit="${escapeAttr(event.id)}" title="Reschedule or edit"><i class="bx bx-edit-alt"></i></button><button class="ops-icon-button" type="button" data-event-duplicate="${escapeAttr(event.id)}" title="Duplicate event"><i class="bx bx-copy"></i></button><button class="ops-icon-button" type="button" data-event-cancel="${escapeAttr(event.id)}" title="Cancel event"><i class="bx bx-x-circle"></i></button>` : ''}<button class="ops-icon-button" type="button" data-event-export="${escapeAttr(event.id)}" title="Export event"><i class="bx bx-export"></i></button><div class="event-export-menu" data-export-menu="${escapeAttr(event.id)}" hidden><a href="${escapeAttr(googleCalendarUrl(event))}" target="_blank" rel="noopener"><i class="bx bxl-google"></i> Google Calendar</a><a href="${escapeAttr(outlookCalendarUrl(event))}" target="_blank" rel="noopener"><i class="bx bxl-microsoft"></i> Outlook Calendar</a><a href="/api/calendar/events/${encodeURIComponent(event.id)}/ics"><i class="bx bx-download"></i> Download ICS</a></div></div>
      </article>`;
      }).join('') :
      '<div class="ops-empty"><i class="bx bx-calendar-x"></i><h3>No events in this view</h3><p>Schedule a member session or reserve a workshop place.</p></div>';
  }

  function addAvailabilitySlot(day, slot = {
    start: '09:00',
    end: '10:00'
  }) {
    const host = $(`.availability-slots[data-day="${day}"]`);
    if (!host || host.children.length >= 6) return;
    host.insertAdjacentHTML('beforeend',
      `<div class="availability-slot"><input type="time" value="${escapeAttr(slot.start)}" aria-label="${escapeAttr(day)} start time"><span>to</span><input type="time" value="${escapeAttr(slot.end)}" aria-label="${escapeAttr(day)} end time"><button type="button" data-remove-slot aria-label="Remove time range"><i class="bx bx-x"></i></button></div>`
      );
  }

  function renderScheduleUpcoming() {
    const host = $('#scheduleUpcomingList');
    if (!host) return;
    const upcoming = (state.calendar?.events || [])
      .filter(event => event.status === 'scheduled' && new Date(event.ends_at).getTime() >= Date.now())
      .sort((first, second) => new Date(first.starts_at) - new Date(second.starts_at))
      .slice(0, 3);
    host.innerHTML = upcoming.length ? upcoming.map(event => `<button class="quick-schedule-next-item" type="button" data-schedule-agenda-event="${escapeAttr(event.id)}"><span class="quick-next-date">${escapeHtml(formatDay(event.starts_at))}</span><span><strong>${escapeHtml(event.title || 'SwapLabs session')}</strong><small>${escapeHtml(formatShortTime(event.starts_at))} · ${Math.round((new Date(event.ends_at) - new Date(event.starts_at)) / 60000)} min</small></span><i class="bx bx-chevron-right" aria-hidden="true"></i></button>`).join('') : '<span class="ops-muted">No sessions booked yet. Your next invite will show here.</span>';
  }

  function renderAvailability() {
    const availability = state.calendar.availability;
    const timezoneField = $('#availabilityTimezone');
    if (timezoneField) {
      timezoneField.innerHTML = timezoneOptions(availability.timezone);
      const bufferField = $('#availabilityForm [name="buffer_minutes"]');
      if (bufferField) bufferField.value = String(availability.buffer_minutes ?? 15);
      const host = $('#availabilityWeek');
      if (host) host.innerHTML = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(day => {
        const slots = availability.weekly?.[day] || [];
        return `<div class="availability-day" data-availability-day="${day}"><label class="availability-day-name"><input type="checkbox" data-day-enabled="${day}" ${slots.length ? 'checked' : ''}><strong>${day[0].toUpperCase()+day.slice(1)}</strong></label><div class="availability-slots" data-day="${day}">${slots.map(slot => `<div class="availability-slot"><input type="time" value="${escapeAttr(slot.start)}" aria-label="${day} start time"><span>to</span><input type="time" value="${escapeAttr(slot.end)}" aria-label="${day} end time"><button type="button" data-remove-slot aria-label="Remove time range"><i class="bx bx-x"></i></button></div>`).join('')}</div><button class="availability-add" type="button" data-add-slot="${day}"><i class="bx bx-plus"></i> Add range</button></div>`;
      }).join('');
    }
    const summary = $('#scheduleTimezoneSummary');
    if (summary) summary.textContent = availability.timezone.replaceAll('_', ' ');
    renderScheduleUpcoming();
    updateAvailabilityClock();
  }

  function updateAvailabilityClock() {
    const zone = $('#availabilityTimezone')?.value || state.calendar?.availability?.timezone || 'UTC';
    const clock = $('#availabilityClock');
    const label = $('#availabilityZoneLabel');
    if (!clock && !label) return;
    try {
      if (clock) clock.textContent = new Intl.DateTimeFormat(undefined, {
        timeZone: zone,
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit'
      }).format(new Date());
      if (label) label.textContent = zone.replaceAll('_', ' ');
    } catch (_error) {
      /* Invalid zones cannot be selected. */ }
  }

  function resetCalendarForm() {
    const form = $('#calendarEventForm');
    if (!form) return;
    form.reset();
    form.elements.event_id.value = '';
    form.elements.conversation_id.value = new URLSearchParams(location.search).get('conversation') || '';
    $('#calendarFormTitle').textContent = 'Schedule a session';
    if ($('#calendarSubmitButton')) $('#calendarSubmitButton').innerHTML = '<i class="bx bx-calendar-check"></i> Schedule session';
    const zone = state.calendar?.availability?.timezone || state.user?.profile?.timezone || 'UTC';
    $('#calendarTimezone').value = zone;
    const start = new Date(Date.now() + 86400000);
    start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15, 0, 0);
    const end = new Date(start.getTime() + 3600000);
    form.elements.starts_at.value = inTimezoneInput(start, zone);
    form.elements.ends_at.value = inTimezoneInput(end, zone);
    form.elements.duration_minutes.value = '60';
    syncCalendarEndTime(form);
    const participant = new URLSearchParams(location.search).get('participant');
    if (participant)[...form.elements.participant_ids.options].forEach(option => option.selected = option.value ===
      participant);
    $$('[name="reminder"]', form).forEach(input => input.checked = ['1440', '60'].includes(input.value));
    form.elements.recurrence.value = 'none';
    form.elements.recurrence_count.value = '1';
    form.elements.all_day.checked = false;
    clearStatus(form);
  }

  function populateCalendarFormOptions() {
    const zone = state.calendar?.availability?.timezone || state.user?.profile?.timezone || 'UTC';
    $('#calendarTimezone').innerHTML = timezoneOptions(zone);
    const allowedRelationships = new Set(['following', 'follower', 'mutual']);
    const contacts = (state.calendar?.contacts || []).filter(member => allowedRelationships.has(member.relationship));
    $('#calendarParticipantsSelect').innerHTML = contacts.length ? contacts.map(member =>
      `<option value="${escapeAttr(member.id)}">${escapeHtml(member.display_name)} · @${escapeHtml(member.username)}</option>`
      ).join('') : '<option value="" disabled>No followers or following yet</option>';
    resetCalendarForm();
  }

  function editCalendarEvent(eventId) {
    setCalendarTab('schedules');
    const event = state.calendar.events.find(item => item.id === eventId);
    const form = $('#calendarEventForm');
    if (!event || !form) return;
    form.elements.event_id.value = event.id;
    form.elements.title.value = event.title;
    form.elements.description.value = event.description || '';
    form.elements.location.value = event.location || '';
    form.elements.meeting_url.value = event.meeting_url || '';
    form.elements.timezone.value = event.timezone;
    form.elements.starts_at.value = inTimezoneInput(event.starts_at, event.timezone);
    form.elements.ends_at.value = inTimezoneInput(event.ends_at, event.timezone);
    setDurationFromLocalRange(form);
    form.elements.all_day.checked = Boolean(event.all_day);
    form.elements.recurrence.value = event.recurrence || 'none';
    form.elements.recurrence_count.value = String(event.recurrence_count || 1);
    form.elements.conversation_id.value = event.conversation_id || '';
    [...form.elements.participant_ids.options].forEach(option => option.selected = (event.participant_ids || [])
      .includes(option.value));
    $$('[name="reminder"]', form).forEach(input => input.checked = (event.reminders_minutes || []).includes(Number(
      input.value)));
    $('#calendarFormTitle').textContent = 'Reschedule or edit session';
    if ($('#calendarSubmitButton')) $('#calendarSubmitButton').innerHTML = '<i class="bx bx-check"></i> Save changes';
    $('.quick-schedule-more', form)?.setAttribute('open', '');
    form.scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    });
  }

  async function loadCalendar() {
    state.calendar = await api('/api/calendar');
    state.calendar.availability = state.calendar.availability || {timezone:'UTC',buffer_minutes:15,weekly:{}};
    state.calendar.availability.timezone = safeTimezone(state.calendar.availability.timezone);
    renderCalendarStats();
    populateCalendarFormOptions();
    renderCalendarEvents();
    renderCalendarBoard();
    renderAvailability();
  }

  function setSessionRatingStatus(message, type = 'error') {
    const host = $('[data-session-rating-status]');
    if (!host) return;
    host.textContent = message || '';
    host.className = message ? `ops-form-status show ${type}` : 'ops-form-status';
  }

  function closeSessionRatingModal() {
    const modal = $('#sessionRatingModal');
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    setSessionRatingStatus('');
  }

  function openSessionRatingModal(eventId) {
    const modal = $('#sessionRatingModal');
    const form = $('#sessionRatingForm');
    const event = state.calendar?.events?.find(item => item.id === eventId);
    if (!modal || !form || !event) return;
    form.reset();
    form.elements.event_id.value = event.id;
    const heading = $('h2', form);
    if (heading) heading.textContent = `How did “${event.title || 'this session'}” go?`;
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    setSessionRatingStatus('');
    requestAnimationFrame(() => $('input[name="rating"]', form)?.focus());
  }

  function setSessionProgressStatus(message, type = 'error') {
    const host = $('[data-session-progress-status]');
    if (!host) return;
    host.textContent = message || '';
    host.className = message ? `ops-form-status show ${type}` : 'ops-form-status';
  }

  function closeSessionProgressModal() {
    const modal = $('#sessionProgressModal');
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    setSessionProgressStatus('');
  }

  function openSessionProgressModal(eventId) {
    const modal = $('#sessionProgressModal');
    const form = $('#sessionProgressForm');
    const session = state.calendar?.events?.find(item => item.id === eventId);
    if (!modal || !form || !session) return;
    const report = session.viewer_progress_report || {};
    form.reset();
    form.elements.event_id.value = session.id;
    form.elements.what_happened.value = report.what_happened || '';
    form.elements.progress.value = report.progress || '';
    form.elements.next_step.value = report.next_step || '';
    const rating = form.querySelector(`input[name="overall_rating"][value="${CSS.escape(String(report.overall_rating || ''))}"]`);
    if (rating) rating.checked = true;
    const heading = $('h2', form);
    if (heading) heading.textContent = report.id ? `Update your report for “${session.title || 'this session'}”` : `How did “${session.title || 'this session'}” move you forward?`;
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    setSessionProgressStatus('');
    requestAnimationFrame(() => form.elements.what_happened?.focus());
  }

  async function syncCalendarEvents() {
    const result = await api('/api/calendar');
    if (!state.calendar) {
      state.calendar = result;
      renderCalendarStats();
      populateCalendarFormOptions();
      renderCalendarEvents();
      renderCalendarBoard();
      renderAvailability();
      return;
    }
    state.calendar.events = result.events;
    state.calendar.contacts = result.contacts;
    renderCalendarStats();
    renderCalendarEvents();
    renderCalendarBoard();
  }

  async function setupCalendar() {
    setupCalendarTabs();
    showAuthenticatedApp('#calendarApp');
    updateHeroClock(state.user.profile?.timezone || undefined);
    setInterval(() => updateHeroClock($('#availabilityTimezone')?.value || state.user.profile?.timezone), 30000);
    try {
      await loadCalendar();
    } catch (error) {
      toast(error.message, 'error');
      return;
    }
    const requestedEventId = new URLSearchParams(location.search).get('event');
    const requestedEvent = requestedEventId ? state.calendar.events.find(item => item.id === requestedEventId) : null;
    if (requestedEvent) {
      state.calendarFilter = 'all';
      $$('button', $('#calendarFilters')).forEach(item => item.classList.toggle('active', item.dataset
        .calendarFilter === 'all'));
      renderCalendarEvents();
      requestAnimationFrame(() => {
        const requestedCard = $(`[data-calendar-event-id="${CSS.escape(requestedEventId)}"]`);
        requestedCard?.classList.add('calendar-event-focus');
        requestedCard?.scrollIntoView({
          behavior: 'smooth',
          block: 'center'
        });
        if (requestedEvent.status === 'completed' && requestedEvent.viewer_can_report_progress) {
          setTimeout(() => openSessionProgressModal(requestedEvent.id), 180);
        }
      });
    }
    $('#calendarFilters')?.addEventListener('click', event => {
      const button = event.target.closest('[data-calendar-filter]');
      if (!button) return;
      state.calendarFilter = button.dataset.calendarFilter;
      $$('button', $('#calendarFilters')).forEach(item => item.classList.toggle('active', item === button));
      renderCalendarEvents();
    });
    $('#calendarViewSwitch')?.addEventListener('click', event => {
      const button = event.target.closest('[data-calendar-view]');
      if (!button) return;
      state.calendarView = button.dataset.calendarView;
      renderCalendarBoard();
    });
    $('#calendarQuickbar')?.addEventListener('click', event => {
      const button = event.target.closest('[data-calendar-template]');
      if (!button) return;
      applyCalendarTemplate(button.dataset.calendarTemplate);
    });
    $$('[data-schedule-preset]').forEach(button => button.addEventListener('click', () => applySchedulePreset(button.dataset.schedulePreset)));
    $('#calendarEventForm')?.addEventListener('input', event => {
      if (event.target.name === 'starts_at') syncCalendarEndTime(event.currentTarget);
    });
    $('#calendarEventForm')?.addEventListener('change', event => {
      if (['starts_at', 'duration_minutes', 'timezone'].includes(event.target.name)) syncCalendarEndTime(event.currentTarget);
    });
    $('[data-schedule-agenda]')?.addEventListener('click', () => $('#calendarAgendaTitle')?.scrollIntoView({behavior: 'smooth', block: 'start'}));
    $('#scheduleUpcomingList')?.addEventListener('click', event => {
      const button = event.target.closest('[data-schedule-agenda-event]');
      if (!button) return;
      state.calendarFilter = 'all';
      setCalendarTab('calendar');
      renderCalendarEvents();
      $(`[data-calendar-event-id="${CSS.escape(button.dataset.scheduleAgendaEvent)}"]`)?.scrollIntoView({behavior: 'smooth', block: 'center'});
    });
    $('#calendarPrevious')?.addEventListener('click', () => {
      const amount = state.calendarView === 'month' ? -1 : state.calendarView === 'week' ? -7 : -1;
      if (state.calendarView === 'month') state.calendarCursor = new Date(state.calendarCursor.getFullYear(), state.calendarCursor.getMonth() - 1, 1);
      else state.calendarCursor = calendarAddDays(state.calendarCursor, amount);
      renderCalendarBoard();
    });
    $('#calendarNext')?.addEventListener('click', () => {
      const amount = state.calendarView === 'month' ? 1 : state.calendarView === 'week' ? 7 : 1;
      if (state.calendarView === 'month') state.calendarCursor = new Date(state.calendarCursor.getFullYear(), state.calendarCursor.getMonth() + 1, 1);
      else state.calendarCursor = calendarAddDays(state.calendarCursor, amount);
      renderCalendarBoard();
    });
    $('#calendarToday')?.addEventListener('click', () => { state.calendarCursor = new Date(); renderCalendarBoard(); });
    $('#calendarNewEvent')?.addEventListener('click', () => prepareCalendarFormAt(new Date()));
    $('#calendarJumpToday')?.addEventListener('click', () => { state.calendarCursor = new Date(); renderCalendarBoard(); });
    $('#calendarDuplicate')?.addEventListener('click', () => {
      const id = $('#calendarEventForm').elements.event_id.value;
      if (!id) {
        toast('Save or open an event before duplicating.', 'error');
        return;
      }
      duplicateCalendarEvent(id);
    });
    $('#calendarBoard')?.addEventListener('click', event => {
      if (Date.now() - state.calendarDragJustFinished < 250) return;
      const eventButton = event.target.closest('[data-grid-event]');
      if (eventButton) {
        event.stopPropagation();
        const item = state.calendar.events.find(entry => entry.id === eventButton.dataset.gridEvent);
        if (item?.viewer_can_edit) editCalendarEvent(item.id);
        else {
          state.calendarFilter = 'all';
          renderCalendarEvents();
          const card = $(`[data-calendar-event-id="${CSS.escape(item?.id || '')}"]`);
          card?.scrollIntoView({behavior:'smooth',block:'center'});
        }
        return;
      }
      const now = event.target.closest('[data-calendar-now]');
      const slot = event.target.closest('[data-calendar-slot]');
      const date = event.target.closest('[data-calendar-date]');
      if (now) prepareCalendarFormAt(new Date());
      if (slot) showQuickEventPopover(slotDateFromPointer(slot, event), slot);
      if (date) {
        showQuickEventPopover(`${date.dataset.calendarDate}T09:00:00`, date);
        if (date.classList.contains('calendar-all-day-slot')) document.querySelector('.calendar-quick-popover [name="all_day"]').checked = true;
      }
    });
    $('#calendarBoard')?.addEventListener('keydown', event => {
      if (!['Enter', ' '].includes(event.key) || event.target.closest('[data-grid-event]')) return;
      const slot = event.target.closest('[data-calendar-slot]');
      const date = event.target.closest('[data-calendar-date]');
      if (!slot && !date) return;
      event.preventDefault();
      if (slot) prepareCalendarFormAt(slot.dataset.calendarSlot);
      if (date) prepareCalendarFormAt(`${date.dataset.calendarDate}T09:00:00`);
    });
    $('#calendarBoard')?.addEventListener('pointerdown', event => {
      const resize = event.target.closest('[data-resize-event]');
      if (resize) return startCalendarResize(resize, event);
      if (event.target.closest('[data-grid-event]')) return;
      const slot = event.target.closest('[data-calendar-slot]');
      if (!slot) return;
      startCalendarDrag(slot, event);
    });
    $('#calendarBoard')?.addEventListener('pointerenter', event => {
      const slot = event.target.closest('[data-calendar-slot]');
      if (!slot || !state.calendarDrag) return;
      updateCalendarDrag(slot);
    });
    window.addEventListener('pointermove', updateCalendarResize);
    window.addEventListener('pointerup', () => {
      if (state.calendarResize) return finishCalendarResize();
      if (state.calendarDrag) finishCalendarDrag();
    });
    window.addEventListener('pointercancel', () => {
      state.calendarDrag = null;
      $$('.calendar-hour-slot').forEach(item => item.classList.remove('is-dragging', 'calendar-drag-origin'));
    });
    $('#calendarDateRail')?.addEventListener('click', event => {
      const agendaDate = event.target.closest('[data-agenda-date]');
      if (agendaDate) {
        state.calendarCursor = new Date(`${agendaDate.dataset.agendaDate}T09:00:00`);
        state.calendarView = 'day';
        renderCalendarBoard();
        prepareCalendarFormAt(`${agendaDate.dataset.agendaDate}T09:00:00`);
        $('#calendarBoard')?.scrollIntoView({behavior: 'smooth', block: 'start'});
      }
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && $('#sessionProgressModal') && !$('#sessionProgressModal').hidden) {
        closeSessionProgressModal();
        return;
      }
      if (event.key === 'Escape' && $('#sessionRatingModal') && !$('#sessionRatingModal').hidden) {
        closeSessionRatingModal();
        return;
      }
      if (event.key === 'Escape' && document.querySelector('.calendar-quick-popover')) {
        document.querySelector('.calendar-quick-popover').remove();
        return;
      }
      if (document.activeElement && /input|textarea|select/i.test(document.activeElement.tagName)) return;
      if (event.key === 'n') {
        $('#calendarNewEvent')?.click();
      } else if (event.key === 't') {
        $('#calendarToday')?.click();
      } else if (event.key === '1') {
        $('#calendarViewSwitch [data-calendar-view="month"]')?.click();
      } else if (event.key === '2') {
        $('#calendarViewSwitch [data-calendar-view="week"]')?.click();
      } else if (event.key === '3') {
        $('#calendarViewSwitch [data-calendar-view="day"]')?.click();
      } else if (event.key === 'd' && $('#calendarEventForm')?.elements.event_id.value) {
        $('#calendarDuplicate')?.click();
      }
    });
    $('#calendarEventList')?.addEventListener('click', async event => {
      const edit = event.target.closest('[data-event-edit]'),
        duplicate = event.target.closest('[data-event-duplicate]'),
        cancel = event.target.closest('[data-event-cancel]'),
        complete = event.target.closest('[data-event-complete]'),
        progress = event.target.closest('[data-event-progress]'),
        rate = event.target.closest('[data-event-rate]'),
        exportButton = event.target.closest('[data-event-export]'),
        copyInvite = event.target.closest('[data-copy-meeting-invite]');
      if (copyInvite) {
        await copyMeetingInvite(copyInvite.dataset.copyMeetingInvite);
        return;
      }
      if (edit) editCalendarEvent(edit.dataset.eventEdit);
      if (progress) {
        openSessionProgressModal(progress.dataset.eventProgress);
        return;
      }
      if (rate) {
        openSessionRatingModal(rate.dataset.eventRate);
        return;
      }
      if (complete) {
        if (!window.confirm('Confirm that this session took place? Its scheduled duration will count toward completed hours. Both members must submit a progress report before the one-credit exchange rule is settled: one-way exchanges transfer 1 credit from learner to teacher, while mutual exchanges transfer nothing.')) return;
        complete.disabled = true;
        try {
          const completedEventId = complete.dataset.eventComplete;
          await api(`/api/calendar/events/${encodeURIComponent(completedEventId)}`, {method:'PATCH', body:{status:'completed'}});
          await loadCalendar();
          window.SwapLabsMetrics?.refresh();
          toast('Session completion confirmed.');
          const completedEvent = state.calendar.events.find(item => item.id === completedEventId);
          if (completedEvent?.viewer_can_report_progress) openSessionProgressModal(completedEventId);
          else if (completedEvent?.viewer_can_rate) openSessionRatingModal(completedEventId);
        } catch (error) { toast(error.message, 'error'); }
        finally { complete.disabled = false; }
      }
      if (duplicate) duplicateCalendarEvent(duplicate.dataset.eventDuplicate);
      if (exportButton) {
        const menu = $(`[data-export-menu="${CSS.escape(exportButton.dataset.eventExport)}"]`);
        if (menu) menu.hidden = !menu.hidden;
      }
      if (cancel) {
        const item = state.calendar.events.find(entry => entry.id === cancel.dataset.eventCancel);
        if (!window.confirm(
            `Cancel ${item?.title || 'this session'}? Every member will see the cancellation in their meeting thread.`)) return;
        try {
          await api(`/api/calendar/events/${encodeURIComponent(cancel.dataset.eventCancel)}`, {
            method: 'DELETE'
          });
          await loadCalendar();
          toast('Session cancelled and participants notified.');
        } catch (error) {
          toast(error.message, 'error');
        }
      }
    });
    $$('[data-close-session-progress]').forEach(button => button.addEventListener('click', closeSessionProgressModal));
    $('#sessionProgressForm')?.addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const eventId = form.elements.event_id.value;
      const data = new FormData(form);
      if (String(data.get('what_happened') || '').trim().length < 5 || String(data.get('progress') || '').trim().length < 5) {
        setSessionProgressStatus('Please complete both required reflection fields before saving.', 'error');
        return;
      }
      if (!data.get('overall_rating')) {
        setSessionProgressStatus('Choose an overall rating before saving.', 'error');
        return;
      }
      const button = $('button[type="submit"]', form);
      setButtonLoading(button, true, 'Saving report');
      try {
        const result = await api(`/api/calendar/events/${encodeURIComponent(eventId)}/progress-report`, {
          method: 'POST',
          body: {
            what_happened: data.get('what_happened'),
            progress: data.get('progress'),
            overall_rating: Number(data.get('overall_rating')),
            next_step: data.get('next_step')
          }
        });
        closeSessionProgressModal();
        await loadCalendar();
        window.SwapLabsMetrics?.refresh();
        toast(result.message || 'Progress report saved.');
        const savedEvent = state.calendar.events.find(item => item.id === eventId);
        if (savedEvent?.viewer_can_rate && !savedEvent?.viewer_rating) openSessionRatingModal(eventId);
      } catch (error) {
        setSessionProgressStatus(error.message, 'error');
      } finally {
        setButtonLoading(button, false);
      }
    });
    $$('[data-close-session-rating]').forEach(button => button.addEventListener('click', closeSessionRatingModal));
    $('#sessionRatingForm')?.addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const eventId = form.elements.event_id.value;
      const rating = Number(new FormData(form).get('rating'));
      if (!rating) {
        setSessionRatingStatus('Choose a rating before saving.', 'error');
        return;
      }
      const button = $('button[type="submit"]', form);
      setButtonLoading(button, true, 'Saving rating');
      try {
        const result = await api(`/api/calendar/events/${encodeURIComponent(eventId)}/rating`, {
          method: 'POST',
          body: {rating, comment: form.elements.comment.value}
        });
        closeSessionRatingModal();
        await loadCalendar();
        toast(result.message || 'Your session rating was saved.');
      } catch (error) {
        setSessionRatingStatus(error.message, 'error');
      } finally {
        setButtonLoading(button, false);
      }
    });
    $('#calendarFormReset')?.addEventListener('click', resetCalendarForm);
    $('#calendarEventForm')?.addEventListener('submit', async event => {
      event.preventDefault();
      clearStatus(event.currentTarget);
      const form = event.currentTarget;
      syncCalendarEndTime(form);
      if (!form.elements.ends_at.value) {
        setStatus(form, 'Choose a date and time before scheduling.', 'error');
        form.elements.starts_at.focus();
        return;
      }
      const button = $('button[type="submit"]', form);
      const id = form.elements.event_id.value;
      const payload = {
        title: form.elements.title.value,
        description: form.elements.description.value,
        starts_at: form.elements.starts_at.value,
        ends_at: form.elements.ends_at.value,
        timezone: form.elements.timezone.value,
        participant_ids: [...form.elements.participant_ids.selectedOptions].map(option => option.value),
        location: form.elements.location.value,
        meeting_url: form.elements.meeting_url.value,
        conversation_id: form.elements.conversation_id.value,
        reminders_minutes: $$('[name="reminder"]:checked', form).map(input => Number(input.value)),
        recurrence: form.elements.recurrence.value,
        recurrence_count: Number(form.elements.recurrence_count.value || 1),
        all_day: form.elements.all_day.checked
      };
      setButtonLoading(button, true, id ? 'Updating' : 'Scheduling');
      try {
        await api(id ? `/api/calendar/events/${encodeURIComponent(id)}` : '/api/calendar/events', {
          method: id ? 'PATCH' : 'POST',
          body: payload
        });
        await loadCalendar();
        setButtonLoading(button, false);
        setStatus(form, id ? 'Session rescheduled and participants notified.' :
          'Session scheduled and invitations sent.', 'success');
        toast(id ? 'Session updated.' : 'Session scheduled.');
      } catch (error) {
        setStatus(form, error.message);
        setButtonLoading(button, false);
      }
    });
    $('#availabilityWeek')?.addEventListener('click', event => {
      const add = event.target.closest('[data-add-slot]'),
        remove = event.target.closest('[data-remove-slot]');
      if (add) {
        addAvailabilitySlot(add.dataset.addSlot);
        $(`[data-day-enabled="${add.dataset.addSlot}"]`).checked = true;
      }
      if (remove) {
        const day = remove.closest('.availability-day');
        remove.closest('.availability-slot').remove();
        const slots = $$('.availability-slot', day);
        if (!slots.length) $('[data-day-enabled]', day).checked = false;
      }
    });
    $('#availabilityWeek')?.addEventListener('change', event => {
      const toggle = event.target.closest('[data-day-enabled]');
      if (!toggle) return;
      const day = toggle.dataset.dayEnabled;
      const slots = $(`.availability-slots[data-day="${day}"]`);
      if (toggle.checked && !slots.children.length) addAvailabilitySlot(day);
      if (!toggle.checked) slots.innerHTML = '';
    });
    $('#availabilityTimezone')?.addEventListener('change', updateAvailabilityClock);
    setInterval(updateAvailabilityClock, 1000);
    $('#availabilityForm')?.addEventListener('submit', async event => {
      event.preventDefault();
      clearStatus(event.currentTarget);
      const weekly = {};
      ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].forEach(day => {
        weekly[day] = $$('.availability-slot', $(`[data-availability-day="${day}"]`)).map(row => ({
          start: $('input:first-child', row).value,
          end: $('input:nth-of-type(2)', row).value
        }));
      });
      const button = $('button[type="submit"]', event.currentTarget);
      setButtonLoading(button, true);
      try {
        const result = await api('/api/calendar/availability', {
          method: 'PATCH',
          body: {
            timezone: event.currentTarget.elements.timezone.value,
            buffer_minutes: Number(event.currentTarget.elements.buffer_minutes.value),
            weekly
          }
        });
        state.calendar.availability = result.availability;
        renderAvailability();
        setButtonLoading(button, false);
        setStatus(event.currentTarget, 'Weekly availability saved.', 'success');
        toast('Availability updated.');
      } catch (error) {
        setStatus(event.currentTarget, error.message);
        setButtonLoading(button, false);
      }
    });
    state.calendarPoll = setInterval(() => {
      if (!document.hidden) syncCalendarEvents().catch(() => {
        /* The next poll retries automatically. */ });
    }, 5000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) syncCalendarEvents().catch(() => {
        /* Keep the current agenda if offline. */ });
    });
  }

  /* Credit ledger */
  function creditEntrySearch(entry) {
    return `${entry.description} ${entry.type} ${entry.reference_id || ''} ${entry.counterparty?.display_name || ''} ${entry.counterparty?.username || ''}`
      .toLowerCase();
  }

  function typeLabel(type) {
    return String(type || '').replaceAll('_', ' ');
  }

  function renderCreditDisputes() {
    const host = $('#creditDisputeList'),
      disputes = state.credits?.disputes || [];
    host.innerHTML = disputes.map(item =>
      `<article class="dispute-card"><div class="dispute-card-head"><strong>${escapeHtml(item.reason)}</strong><span class="dispute-status ${escapeAttr(item.status)}">${escapeHtml(item.status)}</span></div><p>${escapeHtml(item.resolution==='pending'?'Administrator review pending':`Resolution: ${item.resolution}${item.refund_amount?` · ${item.refund_amount} credits`:''}`)}</p><p>${escapeHtml(formatDate(item.updated_at))}</p></article>`
      ).join('');
    $('#creditDisputeEmpty').hidden = disputes.length > 0;
  }

  function canDispute(entry) {
    return entry.type === 'payment' && Number(entry.amount) < 0 && !state.credits.disputes.some(item => item
      .ledger_entry_id === entry.id && ['open', 'reviewing'].includes(item.status));
  }

  function renderLedger() {
    const term = String($('#ledgerSearch')?.value || '').trim().toLowerCase(),
      type = $('#ledgerType')?.value || 'all';
    const entries = (state.credits?.entries || []).filter(entry => (type === 'all' || entry.type === type) &&
      creditEntrySearch(entry).includes(term));
    const rows = $('#ledgerRows'),
      mobile = $('#ledgerMobileList');
    const desktop = entry =>
      `<tr><td><div class="ledger-record"><strong>${escapeHtml(entry.description)}</strong><span>${escapeHtml(formatDate(entry.created_at))}<br>${escapeHtml(entry.reference_id||entry.id)}</span></div></td><td><span class="ledger-type ${escapeAttr(entry.type)}">${escapeHtml(typeLabel(entry.type))}</span></td><td><div class="ledger-party"><strong>${escapeHtml(entry.counterparty?.display_name||(entry.created_by==='system'?'SwapLabs system':entry.created_by||'Platform'))}</strong><span>${entry.counterparty?`@${escapeHtml(entry.counterparty.username)}`:escapeHtml(entry.reference_type||'platform')}</span></div></td><td><span class="ledger-amount ${Number(entry.amount)>0?'positive':Number(entry.amount)<0?'negative':''}">${Number(entry.amount)>0?'+':''}${Number(entry.amount)}</span></td><td><span class="ledger-balance">${Number(entry.balance_after)}</span></td><td>${canDispute(entry)?`<button class="ledger-dispute-button" type="button" data-credit-dispute="${escapeAttr(entry.id)}">Dispute</button>`:''}</td></tr>`;
    const card = entry =>
      `<article class="ledger-mobile-card"><div class="ledger-mobile-head"><span class="ledger-type ${escapeAttr(entry.type)}">${escapeHtml(typeLabel(entry.type))}</span><span class="ledger-amount ${Number(entry.amount)>0?'positive':Number(entry.amount)<0?'negative':''}">${Number(entry.amount)>0?'+':''}${Number(entry.amount)}</span></div><p><strong>${escapeHtml(entry.description)}</strong><br>${escapeHtml(formatDate(entry.created_at))}</p><div class="ledger-mobile-meta"><div><span>Member or source</span><strong>${escapeHtml(entry.counterparty?.display_name||'SwapLabs system')}</strong></div><div><span>Balance after</span><strong>${Number(entry.balance_after)} credits</strong></div></div>${canDispute(entry)?`<button class="ledger-dispute-button" type="button" data-credit-dispute="${escapeAttr(entry.id)}">Dispute payment</button>`:''}</article>`;
    rows.innerHTML = entries.map(desktop).join('');
    mobile.innerHTML = entries.map(card).join('');
    $('#ledgerEmpty').hidden = entries.length > 0;
  }

  function renderCredits() {
    const result = state.credits;
    $('#creditBalance').textContent = result.balance;
    $('#heroCreditBalance').textContent = result.balance;
    $('#creditEarned').textContent = result.stats.earned;
    $('#creditSpent').textContent = result.stats.spent;
    $('#creditDisputes').textContent = result.stats.open_disputes;
    const select = $('#creditRecipient'),
      current = select.value;
    select.innerHTML = '<option value="">Choose a member</option>' + result.contacts.map(member =>
      `<option value="${escapeAttr(member.id)}">${escapeHtml(member.display_name)} · @${escapeHtml(member.username)}</option>`
      ).join('');
    if (result.contacts.some(member => member.id === current)) select.value = current;
    renderLedger();
    renderCreditDisputes();
  }
  async function loadCredits() {
    state.credits = await api('/api/credits');
    renderCredits();
  }

  function openCreditDispute(entryId) {
    const entry = state.credits.entries.find(item => item.id === entryId);
    if (!entry) return;
    const form = $('#creditDisputeForm');
    form.elements.ledger_entry_id.value = entry.id;
    $('#creditDisputeContext').textContent =
      `Payment of ${Math.abs(entry.amount)} credits${entry.counterparty?` to ${entry.counterparty.display_name}`:''} on ${formatDate(entry.created_at)}. The original ledger entry remains unchanged during review.`;
    $('#creditDisputeModal').hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeCreditDispute() {
    const modal = $('#creditDisputeModal');
    if (modal) modal.hidden = true;
    document.body.style.overflow = '';
    $('#creditDisputeForm')?.reset();
    clearStatus($('#creditDisputeForm'));
  }
  async function setupCredits() {
    showAuthenticatedApp('#creditApp');
    try {
      await loadCredits();
    } catch (error) {
      toast(error.message, 'error');
      return;
    }
    $('#ledgerSearch')?.addEventListener('input', renderLedger);
    $('#ledgerType')?.addEventListener('change', renderLedger);
    $('#creditRefresh')?.addEventListener('click', () => loadCredits().catch(error => toast(error.message,
      'error')));
    $('#creditTransferForm')?.addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      clearStatus(form);
      const fields = new FormData(form),
        button = $('button[type="submit"]', form);
      const amount = Number(fields.get('amount')),
        recipient = state.credits.contacts.find(item => item.id === fields.get('recipient_id'));
      if (!window.confirm(
          `Transfer ${amount} credit${amount===1?'':'s'} to ${recipient?.display_name||'this member'}?`))
        return;
      setButtonLoading(button, true, 'Transferring');
      try {
        await api('/api/credits/transfer', {
          method: 'POST',
          body: {
            recipient_id: fields.get('recipient_id'),
            amount,
            description: fields.get('description')
          }
        });
        form.reset();
        await loadCredits();
        setButtonLoading(button, false);
        setStatus(form, 'Payment recorded in both members’ ledgers.', 'success');
        toast('Credit payment complete.');
      } catch (error) {
        setStatus(form, error.message);
        setButtonLoading(button, false);
      }
    });
    const disputeClick = event => {
      const button = event.target.closest('[data-credit-dispute]');
      if (button) openCreditDispute(button.dataset.creditDispute);
    };
    $('#ledgerRows')?.addEventListener('click', disputeClick);
    $('#ledgerMobileList')?.addEventListener('click', disputeClick);
    $$('[data-close-credit-modal]').forEach(button => button.addEventListener('click', closeCreditDispute));
    $('#creditDisputeForm')?.addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      clearStatus(form);
      const fields = new FormData(form),
        button = $('button[type="submit"]', form);
      setButtonLoading(button, true, 'Opening review');
      try {
        await api('/api/credits/disputes', {
          method: 'POST',
          body: {
            ledger_entry_id: fields.get('ledger_entry_id'),
            reason: fields.get('reason'),
            details: fields.get('details')
          }
        });
        setButtonLoading(button, false);
        closeCreditDispute();
        await loadCredits();
        toast('Dispute opened for administrator review.');
      } catch (error) {
        setStatus(form, error.message);
        setButtonLoading(button, false);
      }
    });
  }

  /* Live session hub */
  function filteredLiveSessions() {
    const now = Date.now();
    const query = state.liveSessionSearch.trim().toLowerCase();
    let events = (state.liveSessions?.events || []).filter(event => event.status === 'scheduled');
    if (state.liveSessionFilter === 'upcoming') {
      events = events.filter(event => new Date(event.ends_at).getTime() >= now);
    } else if (state.liveSessionFilter === 'rooms') {
      events = events.filter(event => event.video_room_id);
    } else if (state.liveSessionFilter === 'hosted') {
      events = events.filter(event => event.host_id === state.user.id);
    }
    if (query) {
      events = events.filter(event => [
        event.title,
        event.description,
        event.location,
        event.host?.display_name,
        ...(event.participants || []).map(member => `${member.display_name} ${member.username}`)
      ].join(' ').toLowerCase().includes(query));
    }
    return events.sort((first, second) => new Date(first.starts_at) - new Date(second.starts_at));
  }

  function renderLiveSessionHub() {
    const host = $('#liveSessionList');
    if (!host) return;
    const events = filteredLiveSessions();
    host.innerHTML = events.length ? events.map(event => {
      const startsAt = new Date(event.starts_at);
      const duration = Math.max(1, Math.round((new Date(event.ends_at) - startsAt) / 60000));
      const isHost = event.host_id === state.user.id;
      const roomParameter = event.video_room_id ?
        `room=${encodeURIComponent(event.video_room_id)}` : `event=${encodeURIComponent(event.id)}`;
      const roomLabel = event.video_room_id ? 'Open live room' : 'Prepare live room';
      const participantNames = (event.participants || []).map(member => member.display_name).join(', ');
      return `<article class="live-session-record">
        <div class="live-session-date"><span>${escapeHtml(new Intl.DateTimeFormat(undefined,{month:'short'}).format(startsAt))}</span><strong>${escapeHtml(String(startsAt.getDate()))}</strong><small>${escapeHtml(formatShortTime(event.starts_at))}</small></div>
        <div class="live-session-record-main"><div class="live-session-badges"><span><i class="bx ${isHost?'bx-broadcast':'bx-user-check'}"></i>${isHost?'You host':'You are invited'}</span><span class="${event.video_room_id?'room-open':''}"><i class="bx bx-video"></i>${event.video_room_id?'Room opened':'Room ready'}</span></div><h3>${escapeHtml(event.title)}</h3><p>${escapeHtml(event.description || 'No session description was added.')}</p><div class="live-session-record-meta"><span><i class="bx bx-time-five"></i>${duration} minutes</span><span><i class="bx bx-globe"></i>${escapeHtml(event.timezone || 'UTC')}</span><span><i class="bx bx-user"></i>${escapeHtml(event.host?.display_name || 'SwapLabs host')}</span><span><i class="bx bx-group"></i>${escapeHtml(participantNames || 'No additional participants')}</span></div></div>
        <div class="live-session-record-actions"><a class="btn btn-primary" href="video-room.html?${roomParameter}"><i class="bx bx-video-plus"></i>${roomLabel}</a>${event.video_invite_token ? `<button class="btn btn-sm" type="button" data-copy-meeting-invite="${escapeAttr(event.video_invite_token)}"><i class="bx bx-link"></i> Copy invite link</button>` : ''}<a class="btn btn-sm" href="calendar.html"><i class="bx bx-calendar"></i> Event details</a><small><i class="bx bx-shield-quarter"></i> Waiting room and attendance controls enabled</small></div>
      </article>`;
    }).join('') : `<div class="ops-empty live-session-empty"><i class="bx bx-video-off"></i><h3>No matching live sessions</h3><p>${state.liveSessionSearch ? 'Try a different search or filter.' : 'Create a calendar session or reserve a workshop. Your real room will appear here automatically.'}</p><div class="hero-actions"><a class="btn btn-primary" href="calendar.html"><i class="bx bx-calendar-plus"></i> Schedule session</a><a class="btn" href="workshops.html"><i class="bx bx-group"></i> Browse workshops</a></div></div>`;
  }

  async function loadLiveSessions() {
    state.liveSessions = await api('/api/calendar');
    renderLiveSessionHub();
  }

  async function setupLiveSessions() {
    showAuthenticatedApp('#liveSessionsApp');
    try {
      await loadLiveSessions();
    } catch (error) {
      $('#liveSessionList').innerHTML = `<div class="ops-empty"><i class="bx bx-error-circle"></i><h3>Sessions unavailable</h3><p>${escapeHtml(error.message)}</p></div>`;
      return;
    }
    $('#liveSessionSearch')?.addEventListener('input', event => {
      state.liveSessionSearch = event.currentTarget.value;
      renderLiveSessionHub();
    });
    $('#liveSessionFilter')?.addEventListener('change', event => {
      state.liveSessionFilter = event.currentTarget.value;
      renderLiveSessionHub();
    });
    $('#liveSessionList')?.addEventListener('click', event => {
      const button = event.target.closest('[data-copy-meeting-invite]');
      if (button) copyMeetingInvite(button.dataset.copyMeetingInvite);
    });
    $('#refreshLiveSessions')?.addEventListener('click', () => loadLiveSessions().catch(error => toast(error.message,
      'error')));
    state.liveSessionPoll = setInterval(() => {
      if (!document.hidden) loadLiveSessions().catch(() => {});
    }, 15000);
  }

  /* Administrator operations */
  function adminStatus(status) {
    return `<span class="dispute-status ${escapeAttr(status)}">${escapeHtml(status)}</span>`;
  }

  function adminEvidenceMessage(message, report) {
    const sender = message.sender?.display_name || message.sender_kind || 'Unknown sender';
    const reported = message.sender_id === report.reported_user_id;
    const selected = message.id === report.message_id;
    const copy = message.original_body || message.body || message.attachment?.name || 'Attachment';
    return `<article class="ops-evidence-message ${reported?'reported':''} ${selected?'selected':''}"><div class="ops-evidence-message-head"><span><strong>${escapeHtml(sender)}</strong><time>${escapeHtml(formatDate(message.created_at))}</time></span><span>${reported?'<b>Reported account</b>':''}${selected?'<b>Selected message</b>':''}</span></div><p>${escapeHtml(copy)}</p>${message.attachment?`<a href="${escapeAttr(message.attachment.url)}" target="_blank" rel="noopener"><i class="bx bx-paperclip"></i> ${escapeHtml(message.attachment.name)}</a>`:''}${message.sender_id?`<button class="ledger-dispute-button" type="button" data-admin-message="${escapeAttr(message.id)}" data-message-status="${message.moderation_status==='removed'?'visible':'removed'}">${message.moderation_status==='removed'?'Restore message':'Remove message'}</button>`:''}</article>`;
  }

  function adminReportSuspensionFields(report) {
    return `<div class="ops-report-suspension" data-report-suspension hidden><label><span>Length</span><input name="suspension_amount" type="number" min="1" max="365" value="1"></label><label><span>Unit</span><select name="suspension_unit"><option value="hours">Hours</option><option value="days" selected>Days</option><option value="weeks">Weeks</option><option value="minutes">Minutes</option></select></label><label class="wide"><span>Reason shown to the member</span><input name="suspension_reason" maxlength="1000" value="${escapeAttr(report.reported_user?.suspension_reason||'')}" placeholder="Explain the timed suspension"></label></div>`;
  }

  function reportSuspensionMinutes(fields) {
    const factor = {
      minutes: 1,
      hours: 60,
      days: 1440,
      weeks: 10080
    } [fields.get('suspension_unit')] || 1440;
    return Math.round(Math.max(1, Number(fields.get('suspension_amount') || 1)) * factor);
  }

  function setReportSuspensionVisibility(form) {
    const host = $('[data-report-suspension]', form);
    if (host) host.hidden = form.elements.action.value !== 'suspended';
  }

  function renderAdminReports() {
    const reports = state.operations.reports || [];
    if (!reports.length)
    return '<div class="ops-empty"><i class="bx bx-check-shield"></i><h3>No message reports</h3><p>New member safety reports will appear here with complete conversation evidence.</p></div>';
    return reports.map((report, index) => {
      const activity = report.conversation_activity || report.evidence || [];
      const conversationTitle = report.conversation?.title || report.conversation?.id ||
        'Conversation unavailable';
      return `<details class="ops-admin-record ops-message-report" ${(index===0&&['open','reviewing'].includes(report.status))?'open':''}><summary><span class="ops-admin-record-icon"><i class="bx bx-flag"></i></span><span><strong>${escapeHtml(report.category.replaceAll('_',' '))}: ${escapeHtml(report.reported_user?.profile?.display_name||'Former member')}</strong><span>Reported by ${escapeHtml(report.reporter?.display_name||'Former member')} · ${escapeHtml(formatDate(report.created_at))} · ${activity.length} messages</span></span>${adminStatus(report.status)}</summary><div class="ops-admin-record-body"><div class="ops-report-context"><div><span>Conversation</span><strong>${escapeHtml(conversationTitle)}</strong></div><div><span>Reported account</span><strong>${escapeHtml(report.reported_user?.profile?.display_name||'Former member')}</strong></div><div><span>Evidence captured</span><strong>${escapeHtml(formatDate(report.evidence_captured_at||report.created_at))}</strong></div></div><p class="ops-member-statement"><i class="bx bx-message-square-detail"></i><span><strong>Member statement</strong>${escapeHtml(report.details)}</span></p><div class="ops-evidence-heading"><div><strong>Full reported conversation activity</strong><span>Authorized administrators can review both sides of the conversation and moderate individual messages.</span></div><span>${activity.length} records</span></div><div class="ops-admin-evidence">${activity.length?activity.map(message=>adminEvidenceMessage(message,report)).join(''):'<p>No message evidence remains.</p>'}</div><form class="ops-admin-controls" data-admin-report-form="${escapeAttr(report.id)}"><select name="status" aria-label="Report status"><option ${report.status==='open'?'selected':''}>open</option><option ${report.status==='reviewing'?'selected':''}>reviewing</option><option ${report.status==='resolved'?'selected':''}>resolved</option><option ${report.status==='dismissed'?'selected':''}>dismissed</option></select><select name="action" aria-label="Moderation action"><option value="pending">No action yet</option><option value="dismissed">Dismiss report</option><option value="warning">Warning</option><option value="restricted">Restrict messaging</option><option value="suspended">Timed suspension</option><option value="restored">Restore account</option></select>${adminReportSuspensionFields(report)}<textarea name="admin_notes" placeholder="Private moderation notes">${escapeHtml(report.admin_notes||'')}</textarea><button class="btn btn-primary btn-sm" type="submit">Save review</button></form></div></details>`;
    }).join('');
  }

  function renderAdminDisputes() {
    const disputes = state.operations.disputes || [];
    return disputes.length ? disputes.map(item =>
        `<details class="ops-admin-record"><summary><span class="ops-admin-record-icon"><i class="bx bx-wallet"></i></span><span><strong>${escapeHtml(item.reason)} · ${Math.abs(item.ledger_entry?.amount||0)} credits</strong><span>${escapeHtml(item.user?.profile?.display_name||'Former member')} and ${escapeHtml(item.counterparty?.profile?.display_name||'Former member')} · ${escapeHtml(formatDate(item.created_at))}</span></span>${adminStatus(item.status)}</summary><div class="ops-admin-record-body"><p class="ops-muted">${escapeHtml(item.details)}</p><form class="ops-admin-controls" data-admin-dispute-form="${escapeAttr(item.id)}"><select name="resolution"><option value="approved">Approve full refund</option><option value="partial">Approve partial refund</option><option value="denied">Deny dispute</option></select><input name="refund_amount" type="number" min="0" max="${Math.abs(item.ledger_entry?.amount||0)}" value="${Math.abs(item.ledger_entry?.amount||0)}"><input value="Maximum ${Math.abs(item.ledger_entry?.amount||0)} credits" disabled><textarea name="admin_notes" required placeholder="Decision evidence and internal rationale">${escapeHtml(item.admin_notes||'')}</textarea><button class="btn btn-primary btn-sm" type="submit" ${['resolved','dismissed'].includes(item.status)?'disabled':''}>Resolve dispute</button></form></div></details>`
        ).join('') :
      '<div class="ops-empty"><i class="bx bx-check-circle"></i><h3>No credit disputes</h3><p>Outgoing-payment disputes will appear here for an administrator decision.</p></div>';
  }

  function renderAdminActivity() {
    return `<div class="ops-admin-table-wrap"><table class="ops-admin-table"><thead><tr><th>Account</th><th>Status</th><th>Messages</th><th>Reports received</th><th>Open reports</th><th>Events</th><th>Ledger records</th><th>Last message</th></tr></thead><tbody>${state.operations.activity.map(item=>`<tr><td><strong>${escapeHtml(item.user.profile.display_name)}</strong><br>@${escapeHtml(item.user.username)}</td><td>${escapeHtml(item.user.status)}${item.user.messaging_restricted?' · messaging restricted':''}</td><td>${item.messages_sent}</td><td>${item.reports_received}</td><td>${item.open_reports}</td><td>${item.calendar_events}</td><td>${item.ledger_entries}</td><td>${escapeHtml(item.last_message_at?formatDate(item.last_message_at):'Never')}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function renderAdminEvents() {
    return `<div class="ops-admin-table-wrap"><table class="ops-admin-table"><thead><tr><th>Event</th><th>Status</th><th>Starts</th><th>Timezone</th><th>Host</th><th>Participants</th><th>Reschedules</th></tr></thead><tbody>${state.operations.events.map(item=>`<tr><td>${escapeHtml(item.title)}</td><td>${escapeHtml(item.status)}</td><td>${escapeHtml(formatDate(item.starts_at))}</td><td>${escapeHtml(item.timezone)}</td><td>${escapeHtml(item.host?.display_name||'Former member')}</td><td>${item.participant_ids?.length||0}</td><td>${item.reschedule_history?.length||0}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function renderAdminLedger() {
    return `<div class="ops-admin-table-wrap"><table class="ops-admin-table"><thead><tr><th>ID</th><th>User</th><th>Type</th><th>Amount</th><th>Balance after</th><th>Reference</th><th>Created by</th><th>Time</th></tr></thead><tbody>${state.operations.ledger.map(item=>`<tr><td>${escapeHtml(item.id)}</td><td>${escapeHtml(item.user_id)}</td><td>${escapeHtml(typeLabel(item.type))}</td><td>${Number(item.amount)>0?'+':''}${Number(item.amount)}</td><td>${Number(item.balance_after)}</td><td>${escapeHtml(item.reference_id||item.reference_type)}</td><td>${escapeHtml(item.created_by)}</td><td>${escapeHtml(formatDate(item.created_at))}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function renderAdminOperations() {
    const host = $('#opsAdminView');
    if (!host) return;
    const views = {
      reports: renderAdminReports,
      disputes: renderAdminDisputes,
      activity: renderAdminActivity,
      events: renderAdminEvents,
      ledger: renderAdminLedger
    };
    host.innerHTML = views[state.adminTab]();
    if (state.adminTab === 'reports') $$('[data-admin-report-form]', host).forEach(form => {
      const report = state.operations.reports.find(item => item.id === form.dataset.adminReportForm);
      if (report && form.elements.action) form.elements.action.value = report.action || 'pending';
      setReportSuspensionVisibility(form);
    });
    $$('[data-admin-tab]').forEach(button => button.classList.toggle('active', button.dataset.adminTab === state
      .adminTab));
  }
  async function loadAdminOperations() {
    state.operations = await api('/api/admin/operations');
    const stats = state.operations.stats;
    [
      ['opsStatConversations', stats.conversations],
      ['opsStatMessages', stats.messages],
      ['opsStatReports', stats.open_reports],
      ['opsStatEvents', stats.scheduled_events],
      ['opsStatLedger', stats.ledger_entries],
      ['opsStatDisputes', stats.open_disputes]
    ].forEach(([id, value]) => {
      if ($(`#${id}`)) $(`#${id}`).textContent = value;
    });
    renderAdminOperations();
  }
  async function setupAdminOperations() {
    const container = $('#adminDashboard .container');
    const operationsHost = $('[data-admin-section="overview"]') || container;
    if (!container || $('#opsAdminPanel') || $('[data-workspace="reports"]')) return;
    operationsHost.insertAdjacentHTML('beforeend',
      `<section class="ops-admin-panel" id="opsAdminPanel"><div class="ops-admin-header"><div><span class="ops-overline">Trust, communication, and exchange</span><h2>Operations moderation</h2><p>Review reported chats with complete activity evidence, moderate content, apply timed suspensions, resolve credit disputes, and inspect calendars and immutable ledger records.</p></div><button class="btn btn-sm" id="opsAdminRefresh" type="button"><i class="bx bx-refresh"></i> Refresh operations</button></div><div class="ops-admin-stats"><article><i class="bx bx-conversation"></i><strong id="opsStatConversations">0</strong><span>Direct conversations</span></article><article><i class="bx bx-message-dots"></i><strong id="opsStatMessages">0</strong><span>Messages and updates</span></article><article><i class="bx bx-flag"></i><strong id="opsStatReports">0</strong><span>Open reports</span></article><article><i class="bx bx-calendar"></i><strong id="opsStatEvents">0</strong><span>Scheduled events</span></article><article><i class="bx bx-list-check"></i><strong id="opsStatLedger">0</strong><span>Ledger records</span></article><article><i class="bx bx-error-circle"></i><strong id="opsStatDisputes">0</strong><span>Open disputes</span></article></div><div class="ops-admin-tabs"><button class="active" data-admin-tab="reports" type="button">Reported chats</button><button data-admin-tab="disputes" type="button">Credit disputes</button><button data-admin-tab="activity" type="button">Member activity</button><button data-admin-tab="events" type="button">Calendar events</button><button data-admin-tab="ledger" type="button">Immutable ledger</button></div><div class="ops-admin-view" id="opsAdminView"><div class="ops-loading"><i class="bx bx-loader-alt bx-spin"></i><span>Loading operations data</span></div></div></section>`
      );
    try {
      await loadAdminOperations();
    } catch (error) {
      $('#opsAdminView').innerHTML =
        `<div class="ops-empty"><i class="bx bx-error-circle"></i><h3>Operations data unavailable</h3><p>${escapeHtml(error.message)}</p></div>`;
    }
    $('#opsAdminRefresh')?.addEventListener('click', () => loadAdminOperations().catch(error => toast(error.message,
      'error')));
    $('#opsAdminPanel')?.addEventListener('click', async event => {
      const tab = event.target.closest('[data-admin-tab]');
      if (tab) {
        state.adminTab = tab.dataset.adminTab;
        renderAdminOperations();
        return;
      }
      const moderation = event.target.closest('[data-admin-message]');
      if (moderation) {
        const removing = moderation.dataset.messageStatus === 'removed';
        const reason = removing ? window.prompt('Why should this message be removed?',
          'Community safety review') : '';
        if (removing && !reason) return;
        try {
          await api(`/api/admin/messages/${encodeURIComponent(moderation.dataset.adminMessage)}/moderate`, {
            method: 'PATCH',
            body: {
              status: moderation.dataset.messageStatus,
              reason
            }
          });
          await loadAdminOperations();
          toast(removing ? 'Message removed while evidence was preserved.' : 'Message restored.');
        } catch (error) {
          toast(error.message, 'error');
        }
      }
    });
    $('#opsAdminPanel')?.addEventListener('change', event => {
      const form = event.target.closest('[data-admin-report-form]');
      if (form && event.target.name === 'action') setReportSuspensionVisibility(form);
    });
    $('#opsAdminPanel')?.addEventListener('submit', async event => {
      const reportForm = event.target.closest('[data-admin-report-form]'),
        disputeForm = event.target.closest('[data-admin-dispute-form]');
      if (!reportForm && !disputeForm) return;
      event.preventDefault();
      const fields = new FormData(event.target),
        button = $('button[type="submit"]', event.target);
      setButtonLoading(button, true);
      try {
        if (reportForm) {
          const body = {
            status: fields.get('status'),
            action: fields.get('action'),
            admin_notes: fields.get('admin_notes')
          };
          if (body.action === 'suspended') {
            body.suspension_minutes = reportSuspensionMinutes(fields);
            body.suspension_reason = fields.get('suspension_reason');
          }
          await api(`/api/admin/message-reports/${encodeURIComponent(reportForm.dataset.adminReportForm)}`, {
            method: 'PATCH',
            body
          });
          toast('Moderation decision saved.');
        } else {
          await api(
          `/api/admin/credit-disputes/${encodeURIComponent(disputeForm.dataset.adminDisputeForm)}`, {
            method: 'PATCH',
            body: {
              resolution: fields.get('resolution'),
              refund_amount: Number(fields.get('refund_amount')),
              admin_notes: fields.get('admin_notes')
            }
          });
          toast('Credit dispute resolved with permanent ledger records.');
        }
        await loadAdminOperations();
      } catch (error) {
        toast(error.message, 'error');
        setButtonLoading(button, false);
      }
    });
  }

  async function initialize() {
    try {
      const auth = await (window.SwapLabsAuth?.get?.() || api('/api/auth/me'));
      state.csrf = auth.csrf_token || '';
      state.user = auth.authenticated ? auth.user : null;
    } catch (_error) {
      document.querySelectorAll('[data-server-required]').forEach(element => element.classList.add('show'));
      $('#opsLoading')?.setAttribute('hidden', '');
      return;
    }
    if (pageRoot && !state.user) {
      showAuthGate();
      return;
    }
    const page = pageRoot?.dataset.operationsPage;
    if (page === 'inbox') await setupInbox();
    if (page === 'calendar') await setupCalendar();
    if (page === 'credits') await setupCredits();
    if (page === 'live-sessions') await setupLiveSessions();
    if (adminRoot && state.user?.role === 'admin') await setupAdminOperations();
  }

  initialize();
})();
