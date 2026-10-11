/*
 * SwapLabs local mode.
 *
 * The production bundle talks to the hosted Worker API. A plain static server
 * has no Worker runtime, so this small browser adapter keeps the complete
 * interaction model usable offline while preserving the same JSON contracts.
 * It only takes over when an /api request is unavailable; a real API response
 * always wins. In localhost mode, the browser state is persisted through the
 * local server into a SQLite file on the computer's SSD. localStorage remains
 * only as a small migration/fallback mirror when the local server is absent.
 */
(() => {
  'use strict';
  if (window.SwapLabsLocalAPI) return;

  const STORE_KEY = 'relayskills-local-demo-v1';
  const CSRF = 'relayskills-local-csrf';
  const LOCAL_STATE_ENDPOINT = '/__local-state';
  const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0']);
  const NOTHING_FOR_NOW_VALUE = 'nothing for now';
  const ONLINE_PRESENCE_WINDOW_SECONDS = 60 * 60;
  const ONLINE_PRESENCE_HISTORY_SECONDS = 14 * 24 * 60 * 60;
  let nativeFetch;
  let localServerReady = false;
  let persistenceQueue = Promise.resolve(true);
  const now = () => new Date().toISOString();
  const safePresencePage = value => {
    const page = String(value || '').trim().slice(0, 120).split(/[?#]/, 1)[0].replace(/^\/+/, '');
    return /^[A-Za-z0-9._/-]+$/.test(page) && page ? page : 'app';
  };
  const id = prefix => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const asList = value => (Array.isArray(value) ? value.filter(Boolean).map(String) : String(value || '').split(',').map(item => item.trim()).filter(Boolean)).filter(item => item.trim().toLowerCase() !== NOTHING_FOR_NOW_VALUE);
  const RELATED_SKILL_FAMILIES = [
    {label: 'Software and web', skills: ['web design', 'web development', 'frontend development', 'front end development', 'front end engineering', 'backend development', 'back end development', 'full stack development', 'full stack', 'ui design', 'ux design', 'user interface design', 'user experience design', 'responsive web design', 'web accessibility', 'html', 'css', 'javascript', 'typescript', 'react', 'vue', 'angular', 'svelte', 'next js', 'node js', 'php', 'java programming', 'c programming', 'c sharp', 'c++ programming', 'rust programming', 'go programming', 'kotlin', 'swift', 'coding', 'programming', 'software testing', 'git', 'github', 'api integration', 'mobile app development', 'android development', 'ios development', 'flutter', 'react native', 'linux administration', 'networking', 'computer networking', 'wordpress', 'ecommerce development', 'database design']},
    {label: 'Data and AI', skills: ['python', 'python programming', 'data analysis', 'data science', 'data visualization', 'data engineering', 'machine learning', 'deep learning', 'artificial intelligence', 'ai application development', 'sql', 'statistics', 'excel', 'excel data analysis', 'power bi', 'tableau', 'r programming', 'computer vision', 'natural language processing', 'nlp', 'prompt engineering', 'generative ai', 'cybersecurity', 'cyber security', 'network security', 'ethical hacking', 'research methods', 'quantitative analysis']},
    {label: 'Visual design and media', skills: ['graphic design', 'visual design', 'branding', 'illustration', 'motion design', 'animation', '3d modeling', 'typography', 'color theory', 'photography', 'portrait photography', 'wildlife photography', 'photo editing', 'video editing', 'video production', 'filmmaking', 'after effects', 'premiere pro', 'lightroom', 'canva', 'presentation design']},
    {label: 'Writing and communication', skills: ['creative writing', 'content writing', 'copywriting', 'technical writing', 'editing', 'proofreading', 'public speaking', 'presentation', 'storytelling', 'interview practice', 'communication', 'writing', 'blogging', 'journalism', 'resume writing', 'business writing', 'grant writing']},
    {label: 'Product and business', skills: ['product planning', 'product strategy', 'project planning', 'project management', 'entrepreneurship', 'digital marketing', 'marketing', 'seo', 'social media marketing', 'sales', 'career planning', 'linkedin', 'community building', 'personal branding', 'customer success', 'business presentations', 'finance basics', 'budgeting', 'leadership']},
    {label: 'Languages and education', skills: ['english', 'english conversation', 'spanish', 'spanish conversation', 'french', 'german', 'hindi', 'nepali', 'tibetan', 'mandarin', 'chinese', 'japanese', 'korean', 'italian', 'portuguese', 'arabic', 'sign language', 'language exchange', 'language learning', 'tutoring', 'teaching', 'lesson planning', 'curriculum design', 'study skills', 'exam preparation']},
    {label: 'Math and science', skills: ['mathematics', 'math', 'discrete mathematics', 'algebra', 'geometry', 'calculus', 'physics', 'chemistry', 'biology', 'astronomy', 'environmental science', 'climate action']},
    {label: 'Music and audio', skills: ['music theory', 'guitar', 'piano', 'singing', 'vocals', 'songwriting', 'electronic music', 'music production', 'beat making', 'djing', 'audio editing', 'mixing', 'mastering', 'drums', 'ukulele', 'violin', 'sound design', 'podcasting']},
    {label: 'Food and hospitality', skills: ['cooking', 'cooking basics', 'indian cooking', 'baking', 'bread baking', 'pastry', 'cake decorating', 'meal prep', 'food styling', 'grilling', 'restaurant service', 'hospitality', 'bartending', 'coffee brewing']},
    {label: 'Maker, home and repair', skills: ['woodworking', 'carpentry', 'metalworking', 'electronics', 'robotics', '3d printing', 'diy', 'home repair', 'plumbing', 'electrical basics']},
    {label: 'Arts, crafts and fashion', skills: ['drawing', 'sketching', 'painting', 'watercolor', 'pottery', 'ceramics', 'embroidery', 'knitting', 'crochet', 'jewelry making', 'prop making', 'fashion design', 'styling', 'makeup artistry', 'floral design', 'creative crafts']},
    {label: 'Wellbeing, fitness and outdoors', skills: ['fitness', 'running', 'yoga', 'pilates', 'mindfulness', 'meditation', 'nutrition', 'habit building', 'sleep hygiene', 'mental wellness', 'strength training', 'football', 'soccer', 'basketball', 'swimming', 'snowboarding', 'hiking', 'camping', 'gardening', 'urban gardening']},
    {label: 'Life and community', skills: ['relationships', 'parenting basics', 'conflict mediation', 'customer service', 'time management', 'volunteering', 'sustainability', 'pet care', 'personal safety']},
    {label: 'Digital literacy', skills: ['digital literacy', 'computer basics', 'office software', 'microsoft office', 'technology', 'online safety']}
  ];
  const RELATED_SKILL_HINTS = [
    {label: 'Data and AI', hints: ['data', 'analytics', 'machine', 'statistics', 'sql', 'python', 'ai', 'artificial', 'cybersecurity', 'cyber', 'research', 'quantitative', 'power bi', 'tableau', 'sheets']},
    {label: 'Software and web', hints: ['web', 'frontend', 'backend', 'development', 'programming', 'coding', 'software', 'framework', 'database', 'api', 'mobile', 'app', 'server', 'cloud', 'linux', 'network', 'testing', 'git', 'devops', 'django', 'flask', 'fastapi', 'laravel', 'postgresql', 'mysql', 'mongodb', 'graphql', 'unity', 'unreal', 'arduino', 'raspberry']},
    {label: 'Music and audio', hints: ['music', 'audio', 'sound', 'song', 'vocal', 'guitar', 'piano', 'drum', 'dj', 'podcast', 'recording']},
    {label: 'Food and hospitality', hints: ['cook', 'bake', 'bread', 'pastry', 'food', 'kitchen', 'restaurant', 'coffee', 'tea', 'catering', 'hospitality', 'barbecue', 'grill']},
    {label: 'Math and science', hints: ['math', 'algebra', 'geometry', 'calculus', 'physics', 'chemistry', 'biology', 'science', 'astronomy', 'geology', 'environment', 'climate', 'engineering', 'psychology', 'sociology', 'geography']},
    {label: 'Languages and education', hints: ['language', 'conversation', 'translation', 'teaching', 'tutor', 'lesson', 'education', 'course', 'learning', 'study', 'classroom', 'curriculum', 'school']},
    {label: 'Writing and communication', hints: ['writing', 'speaking', 'communication', 'story', 'journal', 'editing', 'proofreading', 'presentation', 'debate', 'negotiation', 'voiceover', 'media literacy']},
    {label: 'Product and business', hints: ['business', 'management', 'marketing', 'sales', 'career', 'finance', 'accounting', 'leadership', 'strategy', 'project', 'product', 'customer', 'operations', 'planning', 'legal', 'fundraising', 'organization']},
    {label: 'Visual design and media', hints: ['design', 'graphic', 'visual', 'brand', 'logo', 'illustration', 'typography', 'animation', 'photo', 'video', 'film', 'media', 'camera', 'editing', 'motion', 'blender', 'cinematography']},
    {label: 'Arts, crafts and fashion', hints: ['drawing', 'sketch', 'painting', 'watercolor', 'art', 'craft', 'fashion', 'style', 'makeup', 'pottery', 'ceramic', 'jewelry', 'paper', 'cosplay', 'calligraphy', 'textile']},
    {label: 'Maker, home and repair', hints: ['wood', 'carpentry', 'metal', 'weld', 'repair', 'home', 'electronics', 'robot', 'print', 'plumbing', 'sewing', 'knitting', 'crochet', 'construction', 'bicycle', 'appliance']},
    {label: 'Wellbeing, fitness and outdoors', hints: ['fitness', 'running', 'yoga', 'health', 'mindfulness', 'meditation', 'nutrition', 'sleep', 'sport', 'football', 'soccer', 'basketball', 'hiking', 'camping', 'climbing', 'swimming', 'dance', 'first aid', 'outdoor', 'survival']},
    {label: 'Life and community', hints: ['parent', 'pet', 'relationship', 'community', 'volunteer', 'sustainability', 'safety', 'travel', 'productivity', 'time', 'goal', 'civic', 'friendship', 'elder care']},
    {label: 'Digital literacy', hints: ['digital', 'computer', 'office', 'online', 'privacy', 'password', 'smartphone', 'remote work', 'virtual collaboration']}
  ];
  const skillKey = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/c\+\+/g, ' cpp ').replace(/c#/g, ' csharp ').replace(/\.net\b/g, ' dotnet ')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  const MATCH_SKILL_ALIASES = new Map([
    ['web dev', 'web development'], ['website development', 'web development'],
    ['website design', 'web design'], ['frontend', 'frontend development'],
    ['front end', 'frontend development'], ['front end dev', 'frontend development'],
    ['backend', 'backend development'], ['back end', 'backend development'],
    ['back end dev', 'backend development'], ['fullstack', 'full stack development'],
    ['full stack dev', 'full stack development'], ['ui ux', 'ui ux design'],
    ['user interface', 'ui design'], ['user experience', 'ux design'],
    ['js', 'javascript'], ['javascript programming', 'javascript'],
    ['ts', 'typescript'], ['python dev', 'python programming'],
    ['data analytics', 'data analysis'], ['machine learning ai', 'machine learning'],
    ['graphic arts', 'graphic design'], ['public speaking practice', 'public speaking'],
    ['spoken english', 'english conversation'], ['english speaking', 'english conversation'],
    ['mindfulness meditation', 'mindfulness'], ['yoga practice', 'yoga'],
    ['fitness training', 'fitness'], ['strength and conditioning', 'strength training'],
    ['soccer football', 'football'], ['content creation', 'content writing'],
    ['project management basics', 'project management']
  ]);
  const MATCH_NOISE_WORDS = new Set(['a', 'an', 'and', 'for', 'the', 'to', 'with', 'in', 'on', 'of', 'basics', 'basic', 'skills', 'skill', 'beginner', 'beginners', 'advanced', 'expert', 'fundamentals', 'introduction', 'intro']);
  const skillCanonicalKey = value => MATCH_SKILL_ALIASES.get(skillKey(value)) || skillKey(value);
  const skillTokens = value => skillCanonicalKey(value).split(' ').filter(token => token && !MATCH_NOISE_WORDS.has(token));
  const skillTokenFit = (left, right) => {
    const leftKey = skillCanonicalKey(left);
    const rightKey = skillCanonicalKey(right);
    if (!leftKey || !rightKey) return false;
    if (leftKey === rightKey) return true;
    const leftTokens = new Set(skillTokens(left));
    const rightTokens = new Set(skillTokens(right));
    if (!leftTokens.size || !rightTokens.size) return false;
    const smaller = leftTokens.size <= rightTokens.size ? leftTokens : rightTokens;
    const larger = leftTokens.size <= rightTokens.size ? rightTokens : leftTokens;
    return [...smaller].every(token => larger.has(token));
  };
  const skillFamily = value => {
    const key = skillKey(value);
    if (!key) return '';
    const exact = RELATED_SKILL_FAMILIES.find(family => family.skills.some(skill => skillKey(skill) === key))?.label;
    if (exact) return exact;
    const tokens = new Set(key.split(' '));
    return RELATED_SKILL_HINTS.find(family => family.hints.some(hint => {
      const normalizedHint = skillKey(hint);
      return normalizedHint.includes(' ') ? key.includes(normalizedHint) : tokens.has(normalizedHint);
    }))?.label || '';
  };
  const relatedSkillFamily = (left, right) => {
    const leftKey = skillKey(left);
    const rightKey = skillKey(right);
    if (!leftKey || !rightKey || leftKey === rightKey) return '';
    const leftFamily = skillFamily(left);
    const rightFamily = skillFamily(right);
    return leftFamily && leftFamily === rightFamily ? leftFamily : '';
  };
  const skillOverlap = (requestedValues, availableValues) => {
    const requested = asList(requestedValues);
    const available = asList(availableValues);
    const direct = [];
    const related = [];
    requested.forEach(wanted => {
      const foundDirect = available.find(candidate => {
        const wantedKey = skillCanonicalKey(wanted);
        const candidateKey = skillCanonicalKey(candidate);
        const comparable = Math.min(wantedKey.length, candidateKey.length) >= 3;
        return wantedKey && candidateKey && (skillTokenFit(wanted, candidate) || comparable && (wantedKey.includes(candidateKey) || candidateKey.includes(wantedKey)));
      });
      if (foundDirect) {
        direct.push({requested: wanted, found: foundDirect, family: skillFamily(wanted) || skillFamily(foundDirect), kind: 'direct'});
        return;
      }
      const foundRelated = available.find(candidate => relatedSkillFamily(wanted, candidate));
      if (foundRelated) related.push({requested: wanted, found: foundRelated, family: relatedSkillFamily(wanted, foundRelated), kind: 'related'});
    });
    return {direct, related, best: direct[0] || related[0] || null};
  };
  window.SwapLabsSkillMatch = {overlap: skillOverlap, relatedFamily: relatedSkillFamily, family: skillFamily, families: RELATED_SKILL_FAMILIES};
  const escapeProfile = value => String(value || '').trim();
  const safeCourseUrl = value => {
    const candidate = String(value || '').trim();
    if (!candidate) return '';
    try {
      const parsed = new URL(candidate);
      return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString().slice(0, 500) : '';
    } catch (_error) { return ''; }
  };
  const fullNamePattern = /^\p{L}+(?:\s+\p{L}+)+$/u;
  const namePartPattern = /^\p{L}+$/u;
  const nameFormatMessage = 'Use letters and spaces only, with at least a first and last name (for example, Tenzin Joshi).';
  const validName = (value, fieldName = 'full_name') => (fieldName === 'full_name' || fieldName === 'display_name' ? fullNamePattern : namePartPattern).test(String(value || '').trim());
  const defaults = {
    users: [], sessionUserId: '', notifications: [], conversations: [], messages: [], events: [],
    workshops: [], workshop_registrations: [], courses: [], contact_messages: [], complaints: [], posts: [], stories: [], blogs: [], blog_comments: [], groups: [], ideas: [], journals: [], portfolios: {}, ledger: [], disputes: [],
    achievements: {}, vouchers: [], livestreams: [], swapjobs: [], follows: [], feedback: [], session_ratings: [], session_point_reviews: [], session_progress_reports: [], streaks: {}, streak_days: [],
    adminMessages: [], reports: [], roadmapVotes: {}, onboarding: {}, presence: {}, presence_days: {},
    study_profiles: {}, study_availability: {}, study_invitations: [], study_rooms: [],
    study_sessions: [], study_messages: [], study_favorites: [], study_reports: [], video_rooms: [], direct_calls: []
  };
  const readStore = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      return {...defaults, ...(saved && typeof saved === 'object' ? saved : {})};
    } catch (_error) { return {...defaults}; }
  };
  let store = readStore();
  const syncStore = () => {
    if (localServerReady) return;
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (saved && typeof saved === 'object') store = {...defaults, ...saved};
    } catch (_error) { /* Keep the in-memory store when local storage is unavailable. */ }
  };
  let localBrandMigrated = false;
  let localConversationMigrated = false;
  const directConversationKey = conversation => {
    if (conversation?.kind !== 'direct') return '';
    const members = [...new Set(asList(conversation.member_ids))].sort();
    return members.length === 2 ? members.join('::') : '';
  };
  const mergeDirectConversationPreferences = conversations => {
    const memberIds = [...new Set(conversations.flatMap(conversation => asList(conversation.member_ids)))];
    const merged = {};
    ['muted_for', 'blocked_for'].forEach(field => {
      merged[field] = [...new Set(conversations.flatMap(conversation => asList(conversation[field])))];
    });
    merged.hidden_for = memberIds.filter(memberId => conversations.every(conversation => asList(conversation.hidden_for).includes(memberId)));
    return merged;
  };
  const consolidateDirectConversations = () => {
    if (!Array.isArray(store.conversations) || !store.conversations.length) return false;
    const grouped = new Map();
    store.conversations.forEach(conversation => {
      const key = directConversationKey(conversation);
      if (!key) return;
      const list = grouped.get(key) || [];
      list.push(conversation);
      grouped.set(key, list);
    });
    const duplicateIds = new Set();
    let changed = false;
    grouped.forEach(conversations => {
      if (conversations.length < 2) return;
      conversations.sort((first, second) => {
        const createdCompare = String(first.created_at || '').localeCompare(String(second.created_at || ''));
        return createdCompare || String(first.id || '').localeCompare(String(second.id || ''));
      });
      const canonical = conversations[0];
      const duplicates = conversations.slice(1);
      const allIds = new Set(conversations.map(conversation => conversation.id));
      const createdAt = conversations.map(conversation => conversation.created_at).filter(Boolean).sort()[0] || canonical.created_at || now();
      const updatedAt = conversations.map(conversation => conversation.updated_at || conversation.created_at).filter(Boolean).sort().at(-1) || createdAt;
      const title = conversations.map(conversation => String(conversation.title || '').trim()).find(Boolean);
      const preferences = mergeDirectConversationPreferences(conversations);
      if (canonical.created_at !== createdAt || canonical.updated_at !== updatedAt || (title && canonical.title !== title)) changed = true;
      canonical.created_at = createdAt;
      canonical.updated_at = updatedAt;
      if (title) canonical.title = title;
      Object.assign(canonical, preferences);
      duplicates.forEach(conversation => duplicateIds.add(conversation.id));
      store.messages = (Array.isArray(store.messages) ? store.messages : []).map(message => {
        if (!allIds.has(message.conversation_id) || message.conversation_id === canonical.id) return message;
        changed = true;
        return {...message, conversation_id: canonical.id};
      });
      store.notifications = (Array.isArray(store.notifications) ? store.notifications : []).map(notificationRecord => {
        if (!allIds.has(notificationRecord.entity_id) || notificationRecord.entity_id === canonical.id) return notificationRecord;
        changed = true;
        return {...notificationRecord, entity_id: canonical.id};
      });
      store.events = (Array.isArray(store.events) ? store.events : []).map(event => {
        if (!allIds.has(event.conversation_id) || event.conversation_id === canonical.id) return event;
        changed = true;
        return {...event, conversation_id: canonical.id};
      });
    });
    if (duplicateIds.size) {
      store.conversations = store.conversations.filter(conversation => !duplicateIds.has(conversation.id));
      changed = true;
    }
    if (changed) localConversationMigrated = true;
    return changed;
  };
  const normalizeStore = () => {
    store.workshop_registrations = Array.isArray(store.workshop_registrations) ? store.workshop_registrations : [];
    store.courses = Array.isArray(store.courses) ? store.courses : [];
    store.contact_messages = Array.isArray(store.contact_messages) ? store.contact_messages : [];
    store.complaints = Array.isArray(store.complaints) ? store.complaints : [];
    store.session_ratings = Array.isArray(store.session_ratings) ? store.session_ratings : [];
    store.session_point_reviews = Array.isArray(store.session_point_reviews) ? store.session_point_reviews : [];
    store.session_progress_reports = Array.isArray(store.session_progress_reports) ? store.session_progress_reports : [];
    store.study_profiles = store.study_profiles && typeof store.study_profiles === 'object' && !Array.isArray(store.study_profiles) ? store.study_profiles : {};
    store.study_availability = store.study_availability && typeof store.study_availability === 'object' && !Array.isArray(store.study_availability) ? store.study_availability : {};
    store.study_invitations = Array.isArray(store.study_invitations) ? store.study_invitations : [];
    store.study_rooms = Array.isArray(store.study_rooms) ? store.study_rooms : [];
    store.study_sessions = Array.isArray(store.study_sessions) ? store.study_sessions : [];
    store.study_messages = Array.isArray(store.study_messages) ? store.study_messages : [];
    store.study_favorites = Array.isArray(store.study_favorites) ? store.study_favorites : [];
    store.study_reports = Array.isArray(store.study_reports) ? store.study_reports : [];
    store.video_rooms = Array.isArray(store.video_rooms) ? store.video_rooms : [];
    store.direct_calls = Array.isArray(store.direct_calls) ? store.direct_calls : [];
    localBrandMigrated = false;
    localConversationMigrated = false;
    store.users = (Array.isArray(store.users) ? store.users : []).map(user => {
      if (user?.role !== 'admin' || user?.username !== 'operations') return user;
      const profile = {...(user.profile || {})};
      const nextProfile = {...profile, display_name: profile.display_name || 'SwapLabs operations', first_name: profile.first_name || 'SwapLabs'};
      if (user.email !== 'support.swaplabs@gmail.com' || profile.display_name !== nextProfile.display_name || profile.first_name !== nextProfile.first_name) {
        localBrandMigrated = true;
      }
      return {...user, email: 'support.swaplabs@gmail.com', profile: nextProfile};
    });
    if (Array.isArray(store.achievements)) store.achievements = {};
    consolidateDirectConversations();
  };
  normalizeStore();
  if (localBrandMigrated || localConversationMigrated) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (_error) { /* Keep the in-memory migration when storage is unavailable. */ }
  }
  const persist = () => {
    let mirrorSaved = true;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
    } catch (_error) {
      mirrorSaved = false;
    }
    if (!localServerReady || typeof nativeFetch !== 'function') return Promise.resolve(mirrorSaved);
    persistenceQueue = persistenceQueue.catch(() => false).then(async () => {
      try {
        const saved = await nativeFetch(LOCAL_STATE_ENDPOINT, {
          method: 'PUT',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({state: store})
        });
        return saved.ok;
      } catch (_error) {
        return false;
      }
    });
    return persistenceQueue;
  };
  const response = (payload, status = 200, headers = {}) => {
    const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? {...payload} : payload;
    if (body && typeof body === 'object' && !Object.prototype.hasOwnProperty.call(body, 'ok')) body.ok = status < 400;
    return new Response(JSON.stringify(body ?? {}), {status, headers: {'Content-Type': 'application/json; charset=utf-8', ...headers}});
  };
  const textResponse = (body, contentType = 'text/plain; charset=utf-8') => new Response(body, {status: 200, headers: {'Content-Type': contentType}});
  const failure = (message, status = 400, extra = {}) => response({error: message, ...extra}, status);
  const readBody = async (resource, init = {}) => {
    const body = init.body;
    if (body instanceof FormData) {
      const result = {};
      for (const [key, value] of body.entries()) result[key] = value instanceof File ? value.name : value;
      return result;
    }
    if (typeof body === 'string') {
      try { return JSON.parse(body || '{}'); } catch (_error) { return Object.fromEntries(new URLSearchParams(body)); }
    }
    if (resource instanceof Request) {
      try {
        const raw = await resource.clone().text();
        return raw ? JSON.parse(raw) : {};
      } catch (_error) { return {}; }
    }
    return body && typeof body === 'object' ? body : {};
  };
  const deviceTimezone = () => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_error) { return 'UTC'; }
  };
  const EXCHANGE_CREDIT_AMOUNT = 1;
  const streakMilestones = [
    {target: 7, reward_credits: 25},
    {target: 30, reward_credits: 100},
    {target: 100, reward_credits: 400},
    {target: 365, reward_credits: 1000}
  ];
  const streakTimezone = value => {
    const candidate = String(value || '').trim();
    if (!candidate) return 'Asia/Kolkata';
    try { new Intl.DateTimeFormat('en-US', {timeZone: candidate}).format(new Date()); return candidate; } catch (_error) { return 'Asia/Kolkata'; }
  };
  const streakTimezoneFor = user => streakTimezone(user?.profile?.timezone || 'Asia/Kolkata');
  const streakDateFor = (value, timezone) => {
    const parsed = new Date(value || Date.now());
    const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
    const parts = new Intl.DateTimeFormat('en-US', {timeZone: streakTimezone(timezone), year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(date);
    const part = type => parts.find(item => item.type === type)?.value || '00';
    return `${part('year')}-${part('month')}-${part('day')}`;
  };
  const streakDateValue = value => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN;
  };
  const streakDistance = (later, earlier) => {
    const difference = streakDateValue(later) - streakDateValue(earlier);
    return Number.isFinite(difference) ? Math.round(difference / 86400000) : NaN;
  };
  const shiftStreakDate = (value, amount) => {
    const dateValue = streakDateValue(value);
    return Number.isFinite(dateValue) ? new Date(dateValue + Number(amount || 0) * 86400000).toISOString().slice(0, 10) : '';
  };
  const ensureLocalStreak = userId => {
    store.streaks ||= {};
    const current = store.streaks[userId];
    if (current && typeof current === 'object') {
      current.streak_freezes = Number.isFinite(Number(current.streak_freezes)) ? Number(current.streak_freezes) : 3;
      current.current_streak = Number(current.current_streak || 0);
      current.longest_streak = Number(current.longest_streak || 0);
      current.freezes_used = Number(current.freezes_used || 0);
      current.milestones = Array.isArray(current.milestones) ? current.milestones : [];
      return current;
    }
    const created = {current_streak: 0, longest_streak: 0, last_activity_date: '', streak_freezes: 3, freezes_used: 0, milestones: [], updated_at: now()};
    store.streaks[userId] = created;
    return created;
  };
  const streakMilestoneRecords = value => (Array.isArray(value) ? value : []).map(item => {
    const target = Number(item && typeof item === 'object' ? item.target : item);
    const definition = streakMilestones.find(candidate => candidate.target === target);
    if (!definition) return null;
    return {...definition, id: `streak-${target}`, awarded: item && typeof item === 'object' ? item.awarded !== false : true, awarded_at: item && typeof item === 'object' ? item.awarded_at || null : null};
  }).filter(Boolean);
  const streakMilestoneState = streak => {
    const awarded = new Set(streakMilestoneRecords(streak.milestones).filter(item => item.awarded !== false).map(item => item.target));
    return streakMilestones.map(definition => ({
      id: `streak-${definition.target}`, target: definition.target, title: `${definition.target}-day streak`, description: `Complete a learning session on ${definition.target} consecutive days.`,
      reward_credits: definition.reward_credits, earned: Number(streak.longest_streak || 0) >= definition.target, reward_awarded: awarded.has(definition.target), progress: Math.min(100, Math.round(Number(streak.current_streak || 0) / definition.target * 100))
    }));
  };
  const streakSummaryFor = user => {
    const streak = ensureLocalStreak(user.id);
    const timezone = streakTimezoneFor(user);
    const today = streakDateFor(new Date(), timezone);
    const dayMap = new Map((store.streak_days || []).filter(item => item.user_id === user.id).map(item => [item.activity_date, item.day_type]));
    const distance = streak.last_activity_date ? streakDistance(today, streak.last_activity_date) : 0;
    const current = distance > 1 ? 0 : Number(streak.current_streak || 0);
    const recentDays = Array.from({length: 7}, (_, index) => {
      const date = shiftStreakDate(today, index - 6);
      const type = dayMap.get(date) || '';
      const status = type === 'learning_session' ? 'complete' : type === 'streak_freeze' ? 'freeze' : date === today ? 'today' : 'missed';
      return {date, label: new Intl.DateTimeFormat('en-US', {timeZone: 'UTC', weekday: 'short'}).format(new Date(`${date}T12:00:00Z`)), status, completed: type === 'learning_session', protected: type === 'streak_freeze'};
    });
    return {
      current_streak: current, longest_streak: Number(streak.longest_streak || 0), streak_freezes: Number(streak.streak_freezes || 0),
      freezes_used: Number(streak.freezes_used || 0), last_activity_date: streak.last_activity_date || null, today,
      today_complete: dayMap.get(today) === 'learning_session', timezone, recent_days: recentDays, milestones: streakMilestoneState({...streak, current_streak: current})
    };
  };
  const recordLearningSessionCompletion = (userId, eventId = '') => {
    const user = findUser(userId);
    if (!user) return null;
    const streak = ensureLocalStreak(userId);
    const occurredAt = now();
    const activityDate = streakDateFor(occurredAt, streakTimezoneFor(user));
    store.streak_days ||= [];
    if (store.streak_days.some(item => item.user_id === userId && item.activity_date === activityDate)) return streakSummaryFor(user);
    store.streak_days.push({user_id: userId, activity_date: activityDate, day_type: 'learning_session', source_id: eventId, occurred_at: occurredAt, created_at: occurredAt});
    const previousDate = streak.last_activity_date || '';
    const distance = previousDate ? streakDistance(activityDate, previousDate) : NaN;
    let next = 1;
    if (previousDate && distance <= 0) { persist(); return streakSummaryFor(user); }
    if (previousDate && distance === 1) next = Number(streak.current_streak || 0) + 1;
    if (previousDate && distance > 1) {
      const missed = distance - 1;
      if (Number(streak.streak_freezes || 0) >= missed) {
        streak.streak_freezes -= missed;
        streak.freezes_used = Number(streak.freezes_used || 0) + missed;
        next = Number(streak.current_streak || 0) + distance;
        for (let offset = 1; offset < distance; offset += 1) {
          store.streak_days.push({user_id: userId, activity_date: shiftStreakDate(previousDate, offset), day_type: 'streak_freeze', source_id: `freeze:${previousDate}:${activityDate}`, occurred_at: occurredAt, created_at: occurredAt});
        }
      }
    }
    streak.current_streak = next;
    streak.longest_streak = Math.max(Number(streak.longest_streak || 0), next);
    streak.last_activity_date = activityDate;
    streak.updated_at = occurredAt;
    const previousMilestones = streakMilestoneRecords(streak.milestones);
    const reachedMilestones = streakMilestones.filter(definition => streak.longest_streak >= definition.target).map(definition => {
      const previousMilestone = previousMilestones.find(item => item.target === definition.target);
      return {...definition, id: `streak-${definition.target}`, awarded: previousMilestone ? previousMilestone.awarded !== false : true, awarded_at: previousMilestone?.awarded_at || occurredAt};
    });
    const alreadyAwarded = new Set(previousMilestones.filter(item => item.awarded !== false).map(item => item.target));
    let rewardBalance = Number(user.time_credits || 0);
    reachedMilestones.filter(item => !alreadyAwarded.has(item.target)).forEach(item => {
      const reference = `streak-milestone-${userId}-${item.target}`;
      if (store.ledger.some(entry => entry.reference_type === 'streak_milestone' && entry.reference_id === reference)) return;
      rewardBalance += Number(item.reward_credits || 0);
      store.ledger.push({id: `streak-reward-${userId}-${item.target}`, user_id: userId, type: 'streak_reward', amount: Number(item.reward_credits || 0), balance_after: rewardBalance, description: `${item.target}-day streak milestone reward`, reference_id: reference, reference_type: 'streak_milestone', created_by: 'system', created_at: occurredAt});
      notification(userId, 'streak_milestone_reward', `You reached a ${item.target}-day streak and earned ${item.reward_credits} credits.`, reference);
    });
    if (rewardBalance !== Number(user.time_credits || 0)) user.time_credits = rewardBalance;
    streak.milestones = reachedMilestones;
    persist();
    return streakSummaryFor(user);
  };
  const automaticTimezone = country => window.SwapLabsOptions?.timezoneForCountry?.(country) || deviceTimezone();
  const applyAutomaticTimezone = profile => {
    if (!profile || typeof profile !== 'object') return profile;
    const countryZones = window.SwapLabsOptions?.timezonesForCountry?.(profile.country);
    if (Array.isArray(countryZones) && countryZones.length) {
      if (!countryZones.includes(String(profile.timezone || ''))) profile.timezone = countryZones[0];
    } else if (!String(profile.timezone || '').trim()) {
      profile.timezone = automaticTimezone(profile.country);
    }
    return profile;
  };
  const profileDefaults = () => ({
    first_name: '', last_name: '', display_name: '', phone_number: '', pronouns: '', gender: '', date_of_birth: '', age: '',
    country: '', city: '', timezone: deviceTimezone(), primary_language: '',
    additional_languages: '', languages_to_learn: '', occupation: '', professional_role: '', organization: '', headline: '',
    bio: '', website: '', availability: '', preferred_format: 'Remote or local', teaching_style: 'Project-based',
    experience_level: 'Intermediate', learning_goal: '', skills_to_teach: '', skills_to_learn: '', skill_details: '', interests: '',
    profile_color: 'green', avatar_url: ''
  });
  const preferencesDefaults = () => ({
    match_visibility: true, show_location: false, email_notifications: true, weekly_digest: true,
    profile_visibility: 'public', theme: 'light', font_scale: 'default', content_density: 'comfortable',
    navigation_style: 'expanded', default_landing: 'dashboard', high_contrast: false, reduced_motion: false,
    link_underlines: false, focus_mode: false, show_ai_assistant: true, auto_play_testimonials: true
  });
  const ageFromDateOfBirth = value => {
    const candidate = String(value || '').trim();
    const birthDate = new Date(`${candidate}T12:00:00Z`);
    if (!candidate || Number.isNaN(birthDate.getTime())) return null;
    const today = new Date();
    let age = today.getUTCFullYear() - birthDate.getUTCFullYear();
    const beforeBirthday = today.getUTCMonth() < birthDate.getUTCMonth() ||
      (today.getUTCMonth() === birthDate.getUTCMonth() && today.getUTCDate() < birthDate.getUTCDate());
    if (beforeBirthday) age -= 1;
    return age;
  };
  const localSafety = (input, profile, previous = {}) => {
    const source = input && typeof input === 'object' ? input : {};
    const old = previous && typeof previous === 'object' ? previous : {};
    const derivedAge = ageFromDateOfBirth(profile.date_of_birth);
    const suppliedAge = Number(profile.age);
    const age = derivedAge !== null ? derivedAge : Number.isFinite(suppliedAge) ? Math.floor(suppliedAge) : null;
    if (derivedAge !== null) profile.age = String(derivedAge);
    const isMinor = Number.isFinite(age) && age >= 3 && age < 13;
    const priorStatus = String(old.guardian_consent_status || source.guardian_consent_status || 'pending');
    return {
      ...old,
      ...source,
      account_type: isMinor ? 'child' : 'adult',
      guardian_consent_status: isMinor && ['pending', 'verified', 'rejected'].includes(priorStatus) ? priorStatus : isMinor ? 'pending' : 'not_applicable',
      is_minor: isMinor,
      minor_messaging: isMinor ? 'connection_only' : 'standard',
      innovation_access: isMinor ? 'specialist_review' : 'standard'
    };
  };
  const publicUser = user => {
    if (!user) return null;
    const profile = {...profileDefaults(), ...(user.profile || {})};
    const follows = Array.isArray(store.follows) ? store.follows : [];
    const visibility = user.preferences?.profile_visibility === 'private' ? 'private' : 'public';
    const followersCount = follows.filter(item => item.following_id === user.id).length;
    const followingCount = follows.filter(item => item.follower_id === user.id).length;
    const isViewer = user.id === store.sessionUserId;
    const isFollowing = follows.some(item => item.follower_id === store.sessionUserId && item.following_id === user.id);
    const followedBy = follows.some(item => item.follower_id === user.id && item.following_id === store.sessionUserId);
    const relationship = isViewer ? 'self' : isFollowing && followedBy ? 'mutual' : isFollowing ? 'following' : followedBy ? 'follower' : 'none';
    const canViewFull = visibility !== 'private' || isViewer || isFollowing;
    const visibleProfile = canViewFull ? profile : {
      ...profile,
      first_name: '', last_name: '', full_name: profile.display_name || user.username,
      headline: '', professional_role: '', occupation: '', bio: '', website: '',
      country: '', city: '', timezone: '', availability: '', preferred_format: '',
      teaching_style: '', experience_level: '', learning_goal: '', interests: [],
      skills_to_teach: [], skills_to_learn: [], languages_to_learn: [], additional_languages: []
    };
    const completedSessions = memberSessionStats(user.id).completed;
    const userIdeas = (store.ideas || []).filter(item => item.owner_id === user.id && item.status === 'published').length;
    return {
      id: user.id, username: user.username, role: user.role || 'member', status: user.status || 'active', verified: Boolean(user.verified),
      time_credits: Number(user.time_credits || 0),
      profile: visibleProfile, profile_color: profile.profile_color, display_name: profile.display_name || user.username,
      country: canViewFull ? profile.country : '', skills_to_teach: canViewFull ? asList(profile.skills_to_teach) : [], skills_to_learn: canViewFull ? asList(profile.skills_to_learn) : [],
      visibility, relationship, followers_count: followersCount, following_count: followingCount,
      published_idea_count: canViewFull ? userIdeas : 0, can_view_full: canViewFull,
      is_minor: Boolean(user.safety?.is_minor), joined_at: user.created_at,
      reputation: {rating: 0, review_count: 0, completed_sessions: completedSessions, reliability_known: completedSessions > 0, reliability_score: completedSessions > 0 ? 100 : 0},
      availability: {label: canViewFull ? profile.availability || 'Availability not set' : 'Private availability', available_now: false, next_overlap_at: null},
      swap_requests_available: true
    };
  };
  const accountUser = user => {
    const safe = publicUser(user);
    if (!safe) return null;
    applyAutomaticTimezone(safe.profile);
    safe.email = user.email;
    safe.preferences = {...preferencesDefaults(), ...(user.preferences || {})};
    safe.safety = localSafety(user.safety, safe.profile, user.safety || {});
    // Reward points are account data. They are deliberately omitted from
    // public member cards and portfolios, but remain available to the owner
    // and protected administration views.
    safe.reward_points = Number(user.reward_points || 0);
    safe.created_at = user.created_at;
    return safe;
  };
  const current = () => store.users.find(user => user.id === store.sessionUserId) || null;
  const requireUser = () => current() ? null : failure('Please log in to continue.', 401);
  const findUser = value => store.users.find(user => user.id === value || user.username === value || user.email === value) || null;
  const profileCompleteness = user => {
    const profile = user?.profile || {};
    const fields = [
      ['first_name', 'First name'], ['last_name', 'Last name'],
      ['date_of_birth', 'Date of birth'], ['country', 'Country'], ['primary_language', 'Primary language'],
      ['skills_to_teach', 'A skill you can teach'], ['skills_to_learn', 'A skill you want to learn'],
      ['learning_goal', 'Main learning goal']
    ];
    const filled = value => Array.isArray(value) ? value.some(filled) : Boolean(String(value ?? '').trim()) && String(value).trim().toLowerCase() !== 'nothing for now';
    return Math.round(fields.filter(([field]) => filled(profile[field])).length / fields.length * 100);
  };
  const profileCompletionMissing = user => {
    const profile = user?.profile || {};
    const fields = [
      ['first_name', 'First name'], ['last_name', 'Last name'],
      ['date_of_birth', 'Date of birth'], ['country', 'Country'], ['primary_language', 'Primary language'],
      ['skills_to_teach', 'A skill you can teach'], ['skills_to_learn', 'A skill you want to learn'],
      ['learning_goal', 'Main learning goal']
    ];
    const filled = value => Array.isArray(value) ? value.some(filled) : Boolean(String(value ?? '').trim()) && String(value).trim().toLowerCase() !== 'nothing for now';
    return fields.filter(([field]) => !filled(profile[field])).map(([, label]) => label);
  };
  const profileCompletionGate = (member, returnTo = 'skill-matching.html') => {
    if (!member || member.role === 'admin') return null;
    const completeness = profileCompleteness(member);
    if (completeness >= 100) return null;
    const requestedReturn = String(returnTo || '').trim();
    const safeReturn = requestedReturn && !requestedReturn.startsWith('//') && !requestedReturn.includes('://') ? requestedReturn : 'skill-matching.html';
    const missing = profileCompletionMissing(member);
    return failure(`Finish your profile to unlock this action${missing.length ? `: add ${missing.slice(0, 3).join(', ').toLowerCase()}${missing.length > 3 ? ', and the remaining essentials' : ''}` : ''}.`, 403, {
      code: 'profile_incomplete', profile_completeness: completeness, required_profile_fields: missing,
      profile_url: `profile.html?complete=1&return_to=${encodeURIComponent(safeReturn)}`, return_to: safeReturn
    });
  };
  const withSession = user => { store.sessionUserId = user?.id || ''; persist(); return accountUser(user); };
  const hash = async value => {
    if (window.crypto?.subtle) {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || '')));
      return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    }
    return btoa(unescape(encodeURIComponent(String(value || ''))));
  };
  const fileToDataUrl = async file => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return `data:${String(file.type || '').toLowerCase()};base64,${btoa(binary)}`;
  };
  const mediaFromForm = async init => {
    const form = init.body instanceof FormData ? init.body : null;
    const file = form?.get('media');
    if (!file || typeof file.arrayBuffer !== 'function') return null;
    const type = String(file.type || '').toLowerCase();
    const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm']);
    if (!allowedTypes.has(type)) return {error: 'Choose a JPG, PNG, WebP, MP4, or WebM file.'};
    if (Number(file.size || 0) <= 0 || Number(file.size || 0) > 2_500_000) {
      return {error: 'Local demo mode stores visual uploads up to 2.5 MB so the browser can keep them safely.'};
    }
    return {type, name: String(file.name || 'shared-media'), size: Number(file.size || 0), url: await fileToDataUrl(file)};
  };
  const blogMediaFromForm = async init => {
    const form = init.body instanceof FormData ? init.body : null;
    const files = form ? form.getAll('media').filter(file => file && typeof file.arrayBuffer === 'function') : [];
    if (files.length > 4) return {error: 'Add up to four images or videos to one blog.'};
    const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm']);
    const media = [];
    let totalSize = 0;
    for (const file of files) {
      const type = String(file.type || '').toLowerCase();
      if (!allowedTypes.has(type)) return {error: 'Choose JPG, PNG, WebP, MP4, or WebM files.'};
      const size = Number(file.size || 0);
      if (size <= 0 || size > 2_500_000) return {error: 'Each blog image or video must be 2.5 MB or smaller in local mode.'};
      totalSize += size;
      if (totalSize > 8_000_000) return {error: 'Keep the combined blog media under 8 MB in local mode.'};
      media.push({type, name: String(file.name || 'blog-media'), size, url: await fileToDataUrl(file)});
    }
    return media;
  };
  const bodyMessage = body => String(body?.body || body?.message || '').trim();
  const memberById = memberId => accountUser(findUser(memberId));
  const viewerId = () => current()?.id || '';
  const directConversationFor = target => {
    const actorId = viewerId();
    if (!actorId || !target?.id || target.id === actorId) return null;
    consolidateDirectConversations();
    const key = directConversationKey({kind: 'direct', member_ids: [actorId, target.id]});
    let conversation = store.conversations.find(item => directConversationKey(item) === key);
    if (!conversation) {
      conversation = {
        id: id('conv'), kind: 'direct', title: target.profile.display_name || target.username,
        member_ids: [actorId, target.id], created_at: now(), updated_at: now()
      };
      store.conversations.unshift(conversation);
    }
    conversation.title ||= target.profile.display_name || target.username;
    conversation.hidden_for = asList(conversation.hidden_for).filter(memberId => memberId !== actorId);
    return conversation;
  };
  const conversationMessages = conversation => store.messages
    .filter(message => message.conversation_id === conversation.id && !asList(message.hidden_for).includes(viewerId()))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const setConversationUserFlag = (conversation, field, enabled) => {
    const userId = viewerId();
    const values = asList(conversation[field]);
    conversation[field] = enabled
      ? [...new Set([...values, userId].filter(Boolean))]
      : values.filter(idValue => idValue !== userId);
  };
  const hideConversationHistoryFor = conversation => {
    const userId = viewerId();
    if (!userId) return;
    store.messages.filter(message => message.conversation_id === conversation.id).forEach(message => {
      message.hidden_for = [...new Set([...asList(message.hidden_for), userId])];
    });
  };
  const conversationView = conversation => {
    const members = asList(conversation.member_ids).filter(memberId => memberId !== viewerId()).map(memberById).filter(Boolean);
    const messages = conversationMessages(conversation);
    const group = conversation.kind === 'group' ? store.groups.find(item => item.conversation_id === conversation.id) : null;
    const latest = messages.at(-1);
    return {
      id: conversation.id, kind: conversation.kind || 'direct', title: conversation.title || members[0]?.profile?.display_name || 'Conversation',
      group_id: group?.id || '',
      members, unread_count: messages.filter(message => message.sender_id !== viewerId() && !message.read).length,
      latest_message: latest ? {body: latest.body, created_at: latest.created_at, sender_id: latest.sender_id} : null,
      event: conversation.event_id ? store.events.find(event => event.id === conversation.event_id) || null : null,
      blocked: asList(conversation.blocked_for).includes(viewerId()),
      muted: asList(conversation.muted_for).includes(viewerId()),
      updated_at: conversation.updated_at || conversation.created_at
    };
  };
  const eventBelongsTo = (event, userId) => Boolean(event && userId && (event.host_id === userId || asList(event.participant_ids).includes(userId)));
  const eventDurationHours = event => {
    const explicitMinutes = Number(event?.duration_minutes);
    if (Number.isFinite(explicitMinutes) && explicitMinutes > 0) return Math.round(explicitMinutes / 60 * 10) / 10;
    const starts = new Date(event?.starts_at || '').getTime();
    const ends = new Date(event?.ends_at || '').getTime();
    if (!Number.isFinite(starts) || !Number.isFinite(ends) || ends <= starts) return 0;
    return Math.round((ends - starts) / 3600000 * 10) / 10;
  };
  const memberSessionStats = userId => {
    const events = (store.events || []).filter(event => eventBelongsTo(event, userId));
    const completed = events.filter(event => event.status === 'completed');
    return {
      completed: completed.length,
      scheduled: events.filter(event => event.status === 'scheduled').length,
      cancelled: events.filter(event => event.status === 'cancelled').length,
      completedHours: Math.round(completed.reduce((total, event) => total + eventDurationHours(event), 0) * 10) / 10
    };
  };
  const sessionMemberIds = event => [...new Set([event?.host_id, ...asList(event?.participant_ids)].filter(Boolean))];
  const sessionRatingsFor = eventId => (store.session_ratings || []).filter(item => item.event_id === eventId);
  const sessionReviewFor = eventId => (store.session_point_reviews || []).find(item => item.event_id === eventId) || null;
  const sessionProgressReportsFor = eventId => (store.session_progress_reports || []).filter(item => item.event_id === eventId);
  const sessionProgressReportFor = (eventId, userId) => sessionProgressReportsFor(eventId).find(item => item.reporter_id === userId) || null;
  const sessionTeachingSkills = user => [...asList(user?.profile?.skills_to_teach), ...asList(user?.profile?.additional_languages)];
  const sessionLearningSkills = user => [...asList(user?.profile?.skills_to_learn), ...asList(user?.profile?.languages_to_learn)];
  const sessionDirectionalFit = (teacher, learner) => skillOverlap(sessionLearningSkills(learner), sessionTeachingSkills(teacher)).best;
  const sessionExchangePlan = event => {
    const memberIds = sessionMemberIds(event);
    if (memberIds.length !== 2) return {mode: 'standard_fee', payer_id: event.credit_payer_id || event.host_id || '', recipient_id: '', fit: null};
    const first = findUser(memberIds[0]);
    const second = findUser(memberIds[1]);
    if (!first || !second) return {mode: 'standard_fee', payer_id: event.credit_payer_id || event.host_id || '', recipient_id: '', fit: null};
    const firstTeachesSecond = sessionDirectionalFit(first, second);
    const secondTeachesFirst = sessionDirectionalFit(second, first);
    if (firstTeachesSecond && secondTeachesFirst) return {mode: 'mutual', payer_id: '', recipient_id: '', fit: null};
    if (firstTeachesSecond) return {mode: 'one_way', payer_id: second.id, recipient_id: first.id, fit: firstTeachesSecond};
    if (secondTeachesFirst) return {mode: 'one_way', payer_id: first.id, recipient_id: second.id, fit: secondTeachesFirst};
    return {mode: 'standard_fee', payer_id: event.credit_payer_id || event.host_id || '', recipient_id: '', fit: null};
  };
  const ensureSessionCreditMetadata = event => {
    if (!event) return false;
    let changed = false;
    if (Number(event.session_cost_credits) !== EXCHANGE_CREDIT_AMOUNT) { event.session_cost_credits = EXCHANGE_CREDIT_AMOUNT; changed = true; }
    if (Number(event.one_way_reward_credits) !== EXCHANGE_CREDIT_AMOUNT) { event.one_way_reward_credits = EXCHANGE_CREDIT_AMOUNT; changed = true; }
    if (!event.credit_payer_id) { event.credit_payer_id = event.host_id || ''; changed = true; }
    if (!event.credit_status) { event.credit_status = event.status === 'completed' ? 'awaiting_reports' : 'not_started'; changed = true; }
    if (!Array.isArray(event.credit_reward_recipients)) { event.credit_reward_recipients = []; changed = true; }
    return changed;
  };
  const sessionProgressSummary = (event, viewer = current()) => {
    ensureSessionCreditMetadata(event);
    const memberIds = sessionMemberIds(event);
    const reports = sessionProgressReportsFor(event.id);
    const viewerReport = viewer ? reports.find(item => item.reporter_id === viewer.id) : null;
    return {
      required_count: memberIds.length,
      submitted_count: reports.filter(item => memberIds.includes(item.reporter_id)).length,
      all_submitted: memberIds.length >= 2 && reports.filter(item => memberIds.includes(item.reporter_id)).length >= memberIds.length,
      viewer_submitted: Boolean(viewerReport),
      viewer_report_id: viewerReport?.id || '',
      status: event.credit_status || 'awaiting_reports',
      session_cost_credits: EXCHANGE_CREDIT_AMOUNT,
      one_way_reward_credits: EXCHANGE_CREDIT_AMOUNT,
      credit_payer_id: event.credit_payer_id || '',
      credit_reward_recipients: Array.isArray(event.credit_reward_recipients) ? event.credit_reward_recipients : [],
      credit_transfer_type: event.credit_transfer_type || sessionExchangePlan(event).mode,
      credit_transfer_amount: Number(event.credit_transfer_amount || (sessionExchangePlan(event).mode === 'mutual' ? 0 : EXCHANGE_CREDIT_AMOUNT)),
      credit_transfer_payer_id: event.credit_transfer_payer_id || sessionExchangePlan(event).payer_id || '',
      credit_transfer_recipient_id: event.credit_transfer_recipient_id || sessionExchangePlan(event).recipient_id || '',
      credit_transfer_skill: event.credit_transfer_skill || sessionExchangePlan(event).fit?.found || sessionExchangePlan(event).fit?.requested || ''
    };
  };
  const settleSessionCredits = event => {
    ensureSessionCreditMetadata(event);
    if (event.status !== 'completed' || event.credit_status === 'settled') return {status: event.credit_status, rewards: event.credit_reward_recipients || []};
    const memberIds = sessionMemberIds(event);
    const reports = sessionProgressReportsFor(event.id).filter(item => memberIds.includes(item.reporter_id));
    if (memberIds.length < 2 || reports.length < memberIds.length) {
      event.credit_status = reports.length ? 'partially_reported' : 'awaiting_reports';
      return {status: event.credit_status, rewards: []};
    }
    const reference = event.credit_settlement_id || `session-settlement-${event.id}`;
    event.credit_settlement_id = reference;
    const plan = sessionExchangePlan(event);
    let transfer = {type: plan.mode, amount: 0, payer_id: plan.payer_id || '', recipient_id: plan.recipient_id || '', skill: plan.fit?.found || plan.fit?.requested || ''};
    const rewards = [];
    if (plan.mode === 'one_way') {
      const payer = findUser(plan.payer_id);
      const teacher = findUser(plan.recipient_id);
      const debitReference = `${reference}:debit`;
      const creditReference = `${reference}:credit`;
      if (payer && teacher && payer.id !== teacher.id && !store.ledger.some(item => item.reference_id === debitReference && item.user_id === payer.id) && !store.ledger.some(item => item.reference_id === creditReference && item.user_id === teacher.id)) {
        payer.time_credits = Number(payer.time_credits || 0) - EXCHANGE_CREDIT_AMOUNT;
        teacher.time_credits = Number(teacher.time_credits || 0) + EXCHANGE_CREDIT_AMOUNT;
        store.ledger.push({id: `${reference}:debit`, user_id: payer.id, type: 'session_exchange', amount: -EXCHANGE_CREDIT_AMOUNT, balance_after: payer.time_credits, description: `1 credit transferred to ${teacher.profile?.display_name || teacher.username} for ${event.title || 'a SwapLabs exchange'}`, counterparty: publicUser(teacher), reference_id: debitReference, reference_type: 'session_exchange_transfer', created_by: payer.id, created_at: now()});
        store.ledger.push({id: `${reference}:credit`, user_id: teacher.id, type: 'session_exchange', amount: EXCHANGE_CREDIT_AMOUNT, balance_after: teacher.time_credits, description: `1 credit received from ${payer.profile?.display_name || payer.username} for ${event.title || 'a SwapLabs exchange'}`, counterparty: publicUser(payer), reference_id: creditReference, reference_type: 'session_exchange_transfer', created_by: payer.id, created_at: now()});
      }
      transfer = {type: 'one_way', amount: EXCHANGE_CREDIT_AMOUNT, payer_id: payer?.id || plan.payer_id, recipient_id: teacher?.id || plan.recipient_id, skill: plan.fit?.found || plan.fit?.requested || ''};
      rewards.push({teacher_id: transfer.recipient_id, learner_id: transfer.payer_id, skill: transfer.skill, kind: plan.fit?.kind || 'direct', family: plan.fit?.family || '', amount: EXCHANGE_CREDIT_AMOUNT});
      if (payer && teacher) {
        notification(payer.id, 'session_credits_settled', `1 credit was transferred to the member who taught you ${transfer.skill || 'this skill'}.`, event.id);
        notification(teacher.id, 'session_credit_reward', `You received 1 credit for teaching ${transfer.skill || 'this skill'} in this one-way exchange.`, event.id);
      }
    } else if (plan.mode === 'mutual') {
      transfer = {type: 'mutual', amount: 0, payer_id: '', recipient_id: '', skill: ''};
      sessionMemberIds(event).forEach(memberId => notification(memberId, 'session_credits_settled', 'This was a mutual exchange, so no credits were transferred.', event.id));
    } else {
      const payer = findUser(plan.payer_id || event.host_id);
      const feeReference = `${reference}:fee`;
      if (payer && !store.ledger.some(item => item.reference_id === feeReference && item.reference_type === 'session_fee')) {
        payer.time_credits = Number(payer.time_credits || 0) - EXCHANGE_CREDIT_AMOUNT;
        store.ledger.push({id: `${reference}:fee`, user_id: payer.id, type: 'session_fee', amount: -EXCHANGE_CREDIT_AMOUNT, balance_after: payer.time_credits, description: `1-credit exchange fee for ${event.title || 'SwapLabs session'}`, reference_id: feeReference, reference_type: 'session_fee', created_by: payer.id, created_at: now()});
      }
      transfer = {type: 'standard_fee', amount: EXCHANGE_CREDIT_AMOUNT, payer_id: payer?.id || plan.payer_id || event.host_id || '', recipient_id: '', skill: ''};
      sessionMemberIds(event).forEach(memberId => notification(memberId, 'session_credits_settled', 'The exchange ended and 1 credit was deducted from the session payer.', event.id));
    }
    event.credit_transfer_type = transfer.type;
    event.credit_transfer_amount = transfer.amount;
    event.credit_transfer_payer_id = transfer.payer_id;
    event.credit_transfer_recipient_id = transfer.recipient_id;
    event.credit_transfer_skill = transfer.skill;
    event.credit_reward_recipients = rewards;
    event.credit_status = 'settled';
    event.credit_settlement_at = now();
    return {status: event.credit_status, rewards, transfer};
  };
  const sessionTranscript = event => {
    if (!event?.conversation_id) return [];
    return (store.messages || [])
      .filter(message => message.conversation_id === event.conversation_id)
      .sort((first, second) => String(first.created_at || '').localeCompare(String(second.created_at || '')))
      .map(message => ({
        id: message.id,
        sender_id: message.sender_id,
        sender: memberById(message.sender_id),
        body: message.original_body || message.body || message.attachment?.name || 'Attachment',
        created_at: message.created_at
      }));
  };
  const ensureSessionConversation = event => {
    if (!event) return false;
    const memberIds = sessionMemberIds(event);
    if (memberIds.length < 2) return false;
    let conversation = event.conversation_id ? store.conversations.find(item => item.id === event.conversation_id) : null;
    const conversationMembers = asList(conversation?.member_ids);
    const usableConversation = conversation && !['assistant', 'bot'].includes(conversation.kind) && memberIds.every(memberId => conversationMembers.includes(memberId));
    if (!usableConversation) {
      conversation = {
        id: id('conversation-meeting'), kind: 'meeting', title: event.title || 'SwapLabs session',
        member_ids: memberIds, event_id: event.id, created_at: now(), updated_at: now()
      };
      store.conversations.unshift(conversation);
    } else {
      conversation.kind = 'meeting';
      conversation.title = event.title || conversation.title || 'SwapLabs session';
      conversation.member_ids = memberIds;
      conversation.event_id = event.id;
      conversation.updated_at = now();
    }
    const changed = event.conversation_id !== conversation.id;
    event.conversation_id = conversation.id;
    return changed;
  };
  const sessionRatingSummary = (event, viewer = current()) => {
    const eligibleIds = sessionMemberIds(event);
    const ratings = sessionRatingsFor(event.id);
    const badCount = ratings.filter(item => Number(item.rating) <= 2).length;
    const review = sessionReviewFor(event.id);
    const viewerRating = viewer ? ratings.find(item => item.rater_id === viewer.id) : null;
    return {
      rating_count: ratings.length,
      eligible_count: eligibleIds.length,
      bad_count: badCount,
      majority_negative: ratings.length >= 2 && badCount > ratings.length / 2,
      status: review?.status || event.points_status || (ratings.length ? 'awarded' : 'awaiting_ratings'),
      viewer_rating: viewerRating ? {rating: Number(viewerRating.rating), comment: viewerRating.comment || '', points_status: viewerRating.points_status || 'awarded', points_awarded: Number(viewerRating.points_awarded || 0)} : null,
      points_review_id: review?.id || event.points_review_id || ''
    };
  };
  const eventView = (event, viewer = current()) => {
    ensureSessionCreditMetadata(event);
    const viewerId = viewer?.id || '';
    const memberIds = sessionMemberIds(event);
    const viewerIsMember = memberIds.includes(viewerId);
    const endsAt = new Date(event?.ends_at || '').getTime();
    const ended = Number.isFinite(endsAt) && endsAt <= Date.now();
    const viewerRating = viewerIsMember ? sessionRatingsFor(event.id).find(item => item.rater_id === viewerId) : null;
    const viewerProgressReport = viewerIsMember ? sessionProgressReportFor(event.id, viewerId) : null;
    const review = sessionReviewFor(event.id);
    const progressSummary = sessionProgressSummary(event, viewer);
    return {
      ...event,
      host: memberById(event.host_id),
      participants: asList(event.participant_ids).map(memberById).filter(Boolean),
      viewer_is_member: viewerIsMember,
      viewer_can_edit: Boolean(viewerId && event.host_id === viewerId && event.status !== 'cancelled'),
      viewer_can_complete: Boolean(viewerIsMember && event.status === 'scheduled' && ended),
      viewer_can_rate: Boolean(viewerIsMember && memberIds.length >= 2 && event.status === 'completed' && !viewerRating),
      viewer_can_report_progress: Boolean(viewerIsMember && memberIds.length >= 2 && event.status === 'completed'),
      viewer_rating: viewerRating ? {rating: Number(viewerRating.rating), comment: viewerRating.comment || '', points_status: viewerRating.points_status || 'awarded'} : null,
      viewer_progress_report: viewerProgressReport ? {...viewerProgressReport} : null,
      rating_summary: sessionRatingSummary(event, viewer),
      progress_summary: progressSummary,
      credit_summary: progressSummary,
      points_review: review ? {id: review.id, status: review.status, reason: review.reason, rating_count: review.rating_count, bad_count: review.bad_count, eligible_count: review.eligible_count, created_at: review.created_at, decided_at: review.decided_at || null} : null
    };
  };
  const SESSION_RATING_POINTS = 10;
  const awardSessionPoints = rating => {
    if (!rating || rating.points_status === 'awarded') return 0;
    const recipient = findUser(rating.rater_id);
    if (!recipient) return 0;
    const amount = SESSION_RATING_POINTS;
    recipient.reward_points = Math.max(0, Number(recipient.reward_points || 0)) + amount;
    rating.points_awarded = amount;
    rating.points_status = 'awarded';
    rating.points_awarded_at = now();
    return amount;
  };
  const revokeSessionPoints = rating => {
    if (!rating) return 0;
    const recipient = findUser(rating.rater_id);
    const amount = rating.points_status === 'awarded' ? Math.max(0, Number(rating.points_awarded || 0) - Number(rating.points_revoked || 0)) : 0;
    if (recipient && amount) recipient.reward_points = Math.max(0, Number(recipient.reward_points || 0) - amount);
    rating.points_revoked = Number(rating.points_revoked || 0) + amount;
    rating.points_status = 'withheld';
    rating.points_revoked_at = now();
    return amount;
  };
  const ensureSessionPointReview = event => {
    const ratings = sessionRatingsFor(event.id);
    const badCount = ratings.filter(item => Number(item.rating) <= 2).length;
    const majorityNegative = ratings.length >= 2 && badCount > ratings.length / 2;
    let review = sessionReviewFor(event.id);
    if (!majorityNegative && !review) return null;
    if (!review) {
      review = {
        id: id('session-review'), event_id: event.id, status: 'pending', reason: 'majority_negative',
        rating_count: ratings.length, bad_count: badCount, eligible_count: sessionMemberIds(event).length,
        rating_ids: ratings.map(item => item.id), transcript: sessionTranscript(event),
        created_at: now(), updated_at: now(), admin_id: '', admin_notes: ''
      };
      store.session_point_reviews.unshift(review);
    } else {
      review.rating_count = ratings.length;
      review.bad_count = badCount;
      review.rating_ids = ratings.map(item => item.id);
      review.transcript = sessionTranscript(event);
      review.updated_at = now();
    }
    if (review.status === 'pending') {
      event.points_status = 'under_review';
      event.points_review_id = review.id;
    }
    return review;
  };
  const adminSessionReviewView = review => {
    const event = store.events.find(item => item.id === review?.event_id);
    const ratings = sessionRatingsFor(review?.event_id);
    return {
      ...review,
      event: event ? eventView(event) : null,
      ratings: ratings.map(item => ({
        id: item.id, rating: Number(item.rating), comment: item.comment || '', rater: accountUser(findUser(item.rater_id)),
        points_status: item.points_status || 'awarded', points_awarded: Number(item.points_awarded || 0), points_revoked: Number(item.points_revoked || 0), created_at: item.created_at
      })),
      transcript: event ? sessionTranscript(event) : (Array.isArray(review?.transcript) ? review.transcript : [])
    };
  };
  const adminEventView = event => ({...eventView(event), points_review: sessionReviewFor(event.id) ? adminSessionReviewView(sessionReviewFor(event.id)) : null});
  const workshopEndAt = workshop => {
    const explicitEnd = new Date(workshop?.ends_at || '').getTime();
    if (Number.isFinite(explicitEnd)) return new Date(explicitEnd).toISOString();
    const starts = new Date(workshop?.starts_at || '').getTime();
    const duration = Math.max(15, Number(workshop?.duration_minutes || 60));
    return Number.isFinite(starts) ? new Date(starts + duration * 60000).toISOString() : '';
  };
  const newWorkshopShareId = () => `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const ensureWorkshopShare = workshop => {
    if (!workshop) return false;
    let changed = false;
    if (!workshop.share_id) {
      workshop.share_id = newWorkshopShareId();
      changed = true;
    }
    const expiresAt = workshopEndAt(workshop);
    if (!workshop.share_expires_at && expiresAt) {
      workshop.share_expires_at = expiresAt;
      changed = true;
    }
    return changed;
  };
  const workshopView = workshop => ({
    ...workshop,
    share_id: workshop.share_id || '',
    share_expires_at: workshop.share_expires_at || workshopEndAt(workshop),
    share_active: workshop.status === 'scheduled' && Boolean(workshop.share_expires_at || workshopEndAt(workshop)) && new Date(workshop.share_expires_at || workshopEndAt(workshop)).getTime() > Date.now(),
    host: memberById(workshop.host_id),
    registered_count: (workshop.registered_user_ids || []).length,
    seats_remaining: Math.max(0, Number(workshop.seat_limit || 20) - (workshop.registered_user_ids || []).length),
    viewer_registered: Boolean(current() && (workshop.registered_user_ids || []).includes(current().id)),
    viewer_is_host: Boolean(current() && workshop.host_id === current().id),
    outcomes: workshop.outcomes || [],
    tags: workshop.tags || []
  });
  const courseLessons = value => {
    let source = value;
    if (typeof source === 'string') {
      try { source = JSON.parse(source); } catch (_error) { source = []; }
    }
    if (!Array.isArray(source)) return [];
    return source.map((lesson, index) => ({
      id: String(lesson?.id || `lesson_${index + 1}`),
      position: index + 1,
      title: String(lesson?.title || '').trim().slice(0, 140),
      description: String(lesson?.description || '').trim().slice(0, 600),
      resource_url: safeCourseUrl(lesson?.resource_url)
    })).filter(lesson => lesson.title).slice(0, 50);
  };
  const courseView = course => {
    const lessons = courseLessons(course.lessons);
    return {
      id: course.id, owner_id: course.owner_id, owner: publicUser(findUser(course.owner_id)),
      title: String(course.title || ''), description: String(course.description || ''),
      category: String(course.category || 'Other'), level: String(course.level || 'All levels'),
      estimated_hours: Number(course.estimated_hours || 1), resource_url: safeCourseUrl(course.resource_url),
      visibility: course.visibility === 'public' ? 'public' : 'private',
      status: course.status === 'published' ? 'published' : 'draft', lessons,
      lesson_count: lessons.length, created_at: course.created_at, updated_at: course.updated_at,
      published_at: course.published_at || null
    };
  };
  const courseInput = source => {
    const body = source && typeof source === 'object' ? source : {};
    const title = String(body.title || '').trim().slice(0, 120);
    const description = String(body.description || '').trim().slice(0, 1800);
    const category = String(body.category || 'Other').trim().slice(0, 80) || 'Other';
    const level = String(body.level || 'All levels').trim().slice(0, 60) || 'All levels';
    const estimatedHours = Number(body.estimated_hours || 1);
    const resourceUrl = safeCourseUrl(body.resource_url);
    const rawResourceUrl = String(body.resource_url || '').trim();
    const lessons = courseLessons(body.lessons);
    const errors = [];
    if (title.length < 3) errors.push('Add a course title with at least 3 characters.');
    if (description.length < 20) errors.push('Add a short description of what learners will learn.');
    if (rawResourceUrl && !resourceUrl) errors.push('Use a valid HTTPS resource link, or leave the course link empty.');
    if (!Number.isFinite(estimatedHours) || estimatedHours < 0.5 || estimatedHours > 100) errors.push('Estimated course time must be between 0.5 and 100 hours.');
    if (!lessons.length) errors.push('Add at least one lesson before publishing.');
    const invalidLessonLink = Array.isArray(body.lessons) && body.lessons.some(lesson => String(lesson?.resource_url || '').trim() && !safeCourseUrl(lesson.resource_url));
    if (invalidLessonLink) errors.push('Use valid HTTPS links for lesson resources, or leave them empty.');
    return {
      title, description, category, level,
      estimated_hours: Math.round(estimatedHours * 2) / 2,
      resource_url: resourceUrl,
      lessons,
      visibility: body.visibility === 'public' ? 'public' : 'private',
      errors
    };
  };
  const workshopRegistrationView = registration => ({
    ...registration,
    user: accountUser(findUser(registration.user_id)),
    workshop: store.workshops.find(item => item.id === registration.workshop_id) || null
  });
  const PUBLIC_IDEA_STATUSES = new Set(['published', 'funded', 'pilot', 'seeking_support']);
  const isPublicIdea = idea => PUBLIC_IDEA_STATUSES.has(String(idea?.status || 'published').toLowerCase());
  const ideaView = idea => {
    if (!idea) return null;
    const comments = Array.isArray(idea.comments) ? idea.comments : [];
    const likes = Array.isArray(idea.like_user_ids) ? idea.like_user_ids : [];
    const saves = Array.isArray(idea.save_user_ids) ? idea.save_user_ids : [];
    const viewerId = current()?.id || '';
    const owner = findUser(idea.owner_id);
    const ownerView = owner ? publicUser(owner) : (idea.owner || null);
    const likeCount = Number.isFinite(Number(idea.like_count)) ? Math.max(0, Number(idea.like_count)) : likes.length;
    const saveCount = Number.isFinite(Number(idea.save_count)) ? Math.max(0, Number(idea.save_count)) : saves.length;
    const commentCount = Math.max(Number(idea.comment_count || 0), comments.length);
    return {
      ...idea,
      owner: ownerView,
      comments: comments.map(comment => ({
        ...comment,
        message: String(comment.message || comment.body || ''),
        author: comment.author || publicUser(findUser(comment.author_id)) || {id: comment.author_id || '', display_name: 'Former member'}
      })),
      like_count: likeCount,
      save_count: saveCount,
      comment_count: commentCount,
      viewer_liked: Boolean(viewerId && likes.includes(viewerId)),
      viewer_saved: Boolean(viewerId && saves.includes(viewerId)),
      viewer_is_owner: Boolean(viewerId && idea.owner_id === viewerId)
    };
  };
  const ideaStats = ideas => ideas.reduce((stats, idea) => {
    const view = ideaView(idea);
    stats.supporters += Number(view?.like_count || 0);
    stats.comments += Number(view?.comment_count || 0);
    stats.funding_requested += Math.max(0, Number(view?.funding_needed || 0));
    return stats;
  }, {ideas: ideas.length, supporters: 0, comments: 0, funding_requested: 0});
  const isSafetySubmission = item => {
    const text = [item?.request_type, item?.category, item?.topic, item?.subject, item?.details, item?.message]
      .map(value => String(value || '').trim().toLowerCase()).join(' ');
    return String(item?.request_type || '').trim().toLowerCase() === 'safety' || /\b(safety|harassment|fraud|impersonation|threat|unsafe|student safety)\b/.test(text);
  };
  const adminContentView = () => {
    const contactMessages = store.contact_messages || [];
    const complaints = store.complaints || [];
    const feedback = store.feedback || [];
    const safetyReports = complaints.filter(isSafetySubmission);
    const workshops = (store.workshops || []).map(workshopView);
    const workshopRegistrations = (store.workshop_registrations || []).map(workshopRegistrationView);
    return {
      ideas: store.ideas || [],
      workshops,
      testimonials: feedback,
      contact_messages: contactMessages,
      complaints,
      feedback,
      workshop_registrations: workshopRegistrations,
      stats: {
        ideas: (store.ideas || []).length,
        student_reviews: (store.ideas || []).filter(item => ['under_review', 'specialist_review'].includes(item.status)).length,
        published_testimonials: feedback.filter(item => item.publication_permission && item.status !== 'archived').length,
        open_complaints: complaints.filter(item => !isSafetySubmission(item) && !['resolved', 'closed'].includes(item.status)).length,
        safety_reports: safetyReports.filter(item => !['resolved', 'closed', 'dismissed'].includes(item.status)).length,
        new_contacts: contactMessages.filter(item => ['new', 'reviewing', 'in_progress', 'waiting'].includes(item.status)).length,
        workshop_registrations: workshopRegistrations.length
      }
    };
  };
  const groupMemberView = memberId => {
    const safe = publicUser(findUser(memberId));
    if (!safe) return null;
    return {
      id: safe.id,
      username: safe.username,
      display_name: safe.profile.display_name || safe.username,
      avatar_url: safe.profile.avatar_url || '',
      profile_color: safe.profile.profile_color || 'indigo'
    };
  };
  const groupConversation = group => {
    let conversation = store.conversations.find(item => item.id === group.conversation_id);
    if (!conversation) {
      conversation = {id: group.conversation_id || id('conversation-group'), kind: 'group', title: group.title, member_ids: [], created_at: group.created_at || now(), updated_at: now()};
      group.conversation_id = conversation.id;
      store.conversations.unshift(conversation);
    }
    conversation.kind = 'group';
    conversation.title = group.title;
    conversation.member_ids = [...new Set((group.member_ids || []).filter(Boolean))];
    conversation.updated_at = now();
    return conversation;
  };
  const communityGroupView = (group, viewerId = '') => {
    group.member_ids = Array.isArray(group.member_ids) ? group.member_ids : [];
    group.moderator_ids = Array.isArray(group.moderator_ids) ? group.moderator_ids : (group.owner_id ? [group.owner_id] : []);
    group.pending_join_requests = Array.isArray(group.pending_join_requests) ? group.pending_join_requests : [];
    const activeRequests = group.pending_join_requests.filter(item => item && (item.status || 'pending') === 'pending');
    const members = group.member_ids.map(groupMemberView).filter(Boolean);
    const joined = Boolean(viewerId && group.member_ids.includes(viewerId));
    const viewerIsModerator = joined && group.moderator_ids.includes(viewerId);
    const pendingRequests = viewerIsModerator ? activeRequests.map(item => groupMemberView(item.user_id)).filter(Boolean) : [];
    return {
      ...group,
      member_count: members.length,
      members: members.slice(0, 12),
      pinned_messages: Array.isArray(group.pinned_messages) ? group.pinned_messages : [],
      joined,
      viewer_request_pending: Boolean(viewerId && activeRequests.some(item => item.user_id === viewerId)),
      viewer_is_moderator: viewerIsModerator,
      pending_join_count: pendingRequests.length,
      pending_join_requests: pendingRequests
    };
  };
  const profileRelationship = (viewerId, targetId) => {
    if (!viewerId || viewerId === targetId) return 'self';
    const follows = store.follows || [];
    const following = follows.some(item => item.follower_id === viewerId && item.following_id === targetId);
    const followedBy = follows.some(item => item.follower_id === targetId && item.following_id === viewerId);
    return following && followedBy ? 'mutual' : following ? 'following' : followedBy ? 'follower' : 'none';
  };
  const calendarContactUsers = viewerId => {
    const activeFollow = item => !item.status || ['accepted', 'active'].includes(String(item.status).toLowerCase());
    const connectedIds = new Set((store.follows || [])
      .filter(item => activeFollow(item) && (item.follower_id === viewerId || item.following_id === viewerId))
      .map(item => item.follower_id === viewerId ? item.following_id : item.follower_id));
    return store.users
      .filter(item => item.id !== viewerId && item.status === 'active' && connectedIds.has(item.id))
      .map(item => publicUser(item));
  };
  const memberPortfolioView = (target, viewerId = '') => {
    const safe = publicUser(target);
    const follows = store.follows || [];
    const followers = follows.filter(item => item.following_id === target.id).length;
    const following = follows.filter(item => item.follower_id === target.id).length;
    const relationship = profileRelationship(viewerId, target.id);
    const visibility = target.preferences?.profile_visibility === 'private' ? 'private' : 'public';
    const canViewFull = visibility !== 'private' || viewerId === target.id || ['following', 'mutual'].includes(relationship);
    safe.visibility = visibility;
    safe.can_view_full = canViewFull;
    safe.is_minor = Boolean(target.safety?.is_minor);
    safe.joined_at = target.created_at;
    safe.followers_count = followers;
    safe.following_count = following;
    safe.relationship = relationship;
    // Re-apply the access decision here instead of trusting publicUser's
    // session-based decision. The portfolio endpoint receives its viewer id
    // explicitly, so a private profile must never leak protected fields when
    // another viewer opens it directly.
    if (!canViewFull) {
      const previewProfile = safe.profile || {};
      safe.profile = {
        ...previewProfile,
        full_name: previewProfile.display_name || target.username,
        headline: '', professional_role: '', occupation: '', bio: '', website: '',
        country: '', city: '', timezone: '', availability: '', preferred_format: '',
        teaching_style: '', experience_level: '', learning_goal: '', interests: [],
        skills_to_teach: [], skills_to_learn: [], languages_to_learn: [], additional_languages: []
      };
      safe.country = '';
      safe.skills_to_teach = [];
      safe.skills_to_learn = [];
    }
    safe.availability = {label: canViewFull ? target.profile.availability || 'Availability not set' : 'Private availability', available_now: false, next_overlap_at: null};
    const completed = store.events.filter(item => item.status === 'completed' && (item.host_id === target.id || item.participant_ids?.includes(target.id))).length;
    const reviews = store.feedback.filter(item => item.author_id === target.id && Number(item.rating) > 0);
    const ideas = store.ideas.filter(item => item.owner_id === target.id && item.status === 'published');
    const workshops = store.workshops.filter(item => item.host_id === target.id).map(workshopView);
    const canSeePrivateAccountData = viewerId === target.id || findUser(viewerId)?.role === 'admin';
    const projects = (store.portfolios[target.id]?.projects || []).map(item => {
      const project = {...item, summary: item.summary || item.description || ''};
      if (!canSeePrivateAccountData) delete project.points_awarded;
      return project;
    });
    const activity = [
      ...store.posts.filter(item => item.author_id === target.id).slice(0, 4).map(item => ({id: item.id, icon: 'bx-edit-alt', title: 'Shared a community note', description: item.body || 'Published a community contribution.', at: item.created_at, href: `community.html#post-${encodeURIComponent(item.id)}`})),
      ...workshops.slice(0, 3).map(item => ({id: item.id, icon: 'bx-chalkboard', title: `Hosted ${item.title}`, description: item.description || 'Hosted a practical community workshop.', at: item.starts_at, href: 'workshops.html'}))
    ].sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0)).slice(0, 8);
    const achievementCatalog = {
      'profile-starter': {icon: 'bx-user-check', title: 'Profile starter', description: 'Added the context that helps useful introductions happen.'},
      'curious-teacher': {icon: 'bx-bulb', title: 'Curious teacher', description: 'Listed a skill to share with the community.'},
      'learning-direction': {icon: 'bx-compass', title: 'Learning direction', description: 'Named a skill or goal to explore next.'}
    };
    const achievements = (store.achievements[target.id] || []).map(item => achievementCatalog[item] || {icon: 'bx-award', title: String(item), description: 'A community progress marker.'});
    const portfolio = store.portfolios[target.id] || {};
    return {
      user: safe,
      locked: !canViewFull,
      portfolio: {accent: portfolio.accent || target.profile.profile_color || 'indigo'},
      stats: {completed_sessions: completed, published_ideas: ideas.length, followers, following, ...(canSeePrivateAccountData ? {points: Number(target.reward_points || 0)} : {}), rating: reviews.length ? reviews.reduce((sum, item) => sum + Number(item.rating || 0), 0) / reviews.length : 0, review_count: reviews.length, reliability_known: completed > 0, reliability_score: completed ? 100 : 0},
      ideas: canViewFull && portfolio.show_ideas !== false ? ideas : [],
      achievements: canViewFull ? achievements : [],
      workshops: canViewFull && portfolio.show_workshops !== false ? workshops : [],
      activity: canViewFull ? activity : [],
      projects: canViewFull ? projects : []
    };
  };
  const blogCommentView = comment => ({...comment, author: publicUser(findUser(comment.author_id))});
  const blogView = post => {
    const likes = Array.isArray(post.like_user_ids) ? post.like_user_ids : [];
    const comments = (store.blog_comments || []).filter(item => item.blog_id === post.id);
    return {
      ...post,
      author: publicUser(findUser(post.author_id)),
      media: Array.isArray(post.media) ? post.media : post.media ? [post.media] : [],
      tags: Array.isArray(post.tags) ? post.tags : asList(post.tags),
      counts: {...(post.counts || {}), likes: likes.length, comments: comments.length},
      viewer_liked: Boolean(current() && likes.includes(current().id)),
      viewer_shared: Boolean(current() && (post.share_user_ids || []).includes(current().id))
    };
  };
  const metrics = () => {
    const skills = [...new Set(store.users.flatMap(user => asList(user.profile?.skills_to_teach)))];
    const activeMembers = store.users.filter(user => user.role === 'member' && user.status === 'active').length;
    const completedSessions = (store.events || []).filter(item => item.status === 'completed').length;
    const creditsExchanged = (store.ledger || []).filter(item => Number(item.amount) > 0).reduce((total, item) => total + Number(item.amount || 0), 0);
    const countries = new Set(store.users.filter(user => user.role === 'member' && user.status === 'active').map(user => user.profile?.country).filter(Boolean)).size;
    const interactionStatus = item => String(item?.status || '').trim().toLowerCase();
    const elapsedInteraction = item => {
      const value = item?.ended_at || item?.ends_at || item?.completed_at || '';
      const time = new Date(value).getTime();
      return Number.isFinite(time) && time <= Date.now();
    };
    const excludedInteractionStatuses = new Set(['cancelled', 'canceled', 'declined', 'missed', 'rejected', 'draft', 'deleted']);
    const eventOccurred = item => {
      const status = interactionStatus(item);
      return !excludedInteractionStatuses.has(status) && ['active', 'completed', 'ended', 'closed', 'in_progress', 'started'].includes(status) || (!excludedInteractionStatuses.has(status) && elapsedInteraction(item));
    };
    const callOccurred = item => ['accepted', 'ended'].includes(interactionStatus(item));
    const attendanceRecords = item => {
      if (Array.isArray(item?.attendance)) return item.attendance;
      try {
        const parsed = JSON.parse(String(item?.attendance || '[]'));
        return Array.isArray(parsed) ? parsed : [];
      } catch (_error) { return []; }
    };
    const attendanceOccurred = item => attendanceRecords(item).some(record => Boolean(record?.joined_at || record?.left_at || Number(record?.duration_seconds || 0) > 0));
    const roomOccurred = item => {
      const status = interactionStatus(item);
      return attendanceOccurred(item) || ['completed', 'ended'].includes(status) || (status === 'closed' && !item?.event_id && !item?.call_id);
    };
    const events = (store.events || []).filter(item => !String(item?.id || '').startsWith('demo-26-'));
    const directCalls = (store.direct_calls || []).filter(item => !String(item?.id || '').startsWith('demo-26-'));
    const videoRooms = (store.video_rooms || []).filter(item => !String(item?.id || '').startsWith('demo-26-'));
    const studySessions = store.study_sessions || [];
    const occurredRooms = videoRooms.filter(roomOccurred);
    const occurredRoomIds = new Set(occurredRooms.map(item => String(item.id || '')).filter(Boolean));
    const occurredEventIds = new Set(occurredRooms.map(item => String(item.event_id || '')).filter(Boolean));
    const occurredCallIds = new Set(occurredRooms.map(item => String(item.call_id || '')).filter(Boolean));
    const countedEvents = events.filter(item => eventOccurred(item) || occurredEventIds.has(String(item.id || '')));
    const countedEventIds = new Set(countedEvents.map(item => String(item.id || '')).filter(Boolean));
    const countedCalls = directCalls.filter(item => callOccurred(item) || occurredCallIds.has(String(item.id || '')));
    const countedCallIds = new Set(countedCalls.map(item => String(item.id || '')).filter(Boolean));
    const countedStudySessions = studySessions.filter(item => {
      const status = interactionStatus(item);
      return !excludedInteractionStatuses.has(status) && (['active', 'completed', 'ended'].includes(status) || elapsedInteraction(item) || occurredRoomIds.has(String(item.video_room_id || '')));
    });
    const countedStudyRoomIds = new Set(countedStudySessions.map(item => String(item.video_room_id || '')).filter(Boolean));
    const standaloneRooms = occurredRooms.filter(room => {
      const eventId = String(room.event_id || '');
      const callId = String(room.call_id || '');
      const roomId = String(room.id || '');
      return (!eventId || !countedEventIds.has(eventId)) && (!callId || !countedCallIds.has(callId)) && !countedStudyRoomIds.has(roomId);
    });
    const allInteractions = countedEvents.length + countedCalls.length + countedStudySessions.length + standaloneRooms.length;
    const hoursExchanged = (store.events || []).filter(item => ['scheduled', 'completed'].includes(item.status)).reduce((total, item) => total + eventDurationHours(item), 0);
    return {members: activeMembers, active_members: activeMembers, public_members: activeMembers, skills: skills.length, listed_skills: skills.length, public_skills: skills.length, exchanges: completedSessions, swaps: completedSessions, sessions: store.events.length, all_interactions: allInteractions, completed_sessions: completedSessions, credits_exchanged: creditsExchanged, countries, hours_exchanged: Number(hoursExchanged.toFixed(1)), skill_names: skills};
  };
  const publicContent = () => {
    const profiles = store.users
      .filter(item => item.role === 'member' && item.status === 'active')
      .map(item => {
        const safe = publicUser(item);
        if (!safe || safe.visibility === 'private') return null;
        const profile = safe.profile || {};
        return {
          ...safe,
          skills_to_teach: [...safe.skills_to_teach, ...asList(profile.additional_languages)],
          skills_to_learn: [...safe.skills_to_learn, ...asList(profile.languages_to_learn)]
        };
      })
      .filter(Boolean);
    const members = profiles.map(member => ({
      href: `member-profile.html?id=${encodeURIComponent(member.id)}`,
      detail: member.skills_to_teach.length ? `${member.skills_to_teach.length} skill${member.skills_to_teach.length === 1 ? '' : 's'} to teach` : 'Public member profile',
      title: member.display_name,
      description: [member.profile?.headline, member.country].filter(Boolean).join(' · ') || 'A public SwapLabs member profile.'
    }));
    const skillCounts = new Map();
    profiles.forEach(member => [...member.skills_to_teach, ...member.skills_to_learn].forEach(skill => {
      const key = skill.toLowerCase();
      const existing = skillCounts.get(key);
      skillCounts.set(key, {title: existing?.title || skill, count: (existing?.count || 0) + 1});
    }));
    const skills = [...skillCounts.values()]
      .sort((first, second) => second.count - first.count || first.title.localeCompare(second.title))
      .slice(0, 60)
      .map(skill => ({
        href: 'browse-skills.html',
        detail: `Listed by ${skill.count} public member${skill.count === 1 ? '' : 's'}`,
        title: skill.title,
        description: 'A skill currently listed by real SwapLabs members.'
      }));
    return {skills, members};
  };
  const notification = (userId, type, message, entityId = '') => store.notifications.push({id: id('note'), user_id: userId, type, message, entity_id: entityId, read: false, created_at: now()});

  // Study Together local-mode records mirror the production API closely enough
  // that the profile, matching, room, session, and chat flows can be exercised
  // on a laptop without a Worker or Durable Object runtime.
  const studyAllowedDurations = [25, 50, 60, 90];
  const studyProfileForLocal = userId => store.study_profiles[userId] || null;
  const studyListLocal = (value, limit = 20) => [...new Set(asList(value).map(item => String(item).trim()).filter(Boolean))].slice(0, limit);
  const studyModesLocal = value => studyListLocal(value, 4).filter(item => ['focus', 'audio', 'video', 'pomodoro', 'check_ins'].includes(item));
  const studyStyleLocal = value => ['quiet_focus', 'occasional_chat', 'discussion', 'accountability', 'co_working'].includes(String(value)) ? String(value) : 'quiet_focus';
  const studyDurationLocal = value => studyAllowedDurations.includes(Number(value)) ? Number(value) : 50;
  const studyVisibilityLocal = value => ['public', 'friends', 'invite_only', 'private'].includes(String(value)) ? String(value) : 'public';
  const studyModeLocal = value => ['focus', 'audio', 'video'].includes(String(value)) ? String(value) : 'focus';
  const studyMinuteLocal = value => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
    if (!match) return null;
    const hour = Number(match[1]); const minute = Number(match[2]);
    return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? hour * 60 + minute : null;
  };
  const studyAvailabilityLocal = value => (Array.isArray(value) ? value : []).slice(0, 14).map(window => ({
    kind: window.kind === 'one_off' ? 'one_off' : 'recurring',
    weekday: Number(window.weekday),
    date_key: /^\d{4}-\d{2}-\d{2}$/.test(String(window.date_key || '')) ? String(window.date_key) : null,
    start: String(window.start || ''),
    end: String(window.end || '')
  })).filter(window => {
    const start = studyMinuteLocal(window.start); const end = studyMinuteLocal(window.end);
    return start !== null && end !== null && end > start && (window.kind === 'one_off' ? window.date_key : Number.isInteger(window.weekday) && window.weekday >= 0 && window.weekday <= 6);
  });
  const studyProfileViewLocal = userId => {
    const profile = studyProfileForLocal(userId);
    if (!profile) return null;
    const user = findUser(userId);
    return {
      user_id: userId,
      status: profile.status || 'active',
      visibility: profile.visibility || 'discoverable',
      subjects: studyListLocal(profile.subjects, 12),
      topics: studyListLocal(profile.topics, 20),
      goals: studyListLocal(profile.goals, 8),
      learning_level: profile.learning_level || 'all_levels',
      timezone: profile.timezone || user?.profile?.timezone || deviceTimezone(),
      session_duration_minutes: studyDurationLocal(profile.session_duration_minutes),
      study_style: studyStyleLocal(profile.study_style),
      modes: studyModesLocal(profile.modes).length ? studyModesLocal(profile.modes) : ['focus'],
      languages: studyListLocal(profile.languages, 8).length ? studyListLocal(profile.languages, 8) : ['English'],
      interests: studyListLocal(profile.interests, 12),
      cross_subject: profile.cross_subject !== false,
      age_band: profile.age_band || 'any',
      current_goal: String(profile.current_goal || ''),
      reliability_score: Number(profile.reliability_score || 0),
      completed_sessions: Number(profile.completed_sessions || 0),
      availability: studyAvailabilityLocal(profile.availability),
      created_at: profile.created_at,
      updated_at: profile.updated_at
    };
  };
  const studySafePersonLocal = (userId, profileOverride = null) => {
    const member = findUser(userId);
    const profile = profileOverride || studyProfileViewLocal(userId);
    if (!member || !profile || member.status !== 'active') return null;
    const base = publicUser(member);
    return {
      id: member.id,
      username: member.username,
      display_name: member.profile?.display_name || member.username,
      profile_color: base?.profile_color || member.profile?.profile_color || 'indigo',
      avatar_url: member.profile?.avatar_url || '',
      timezone: profile.timezone,
      timezone_region: String(profile.timezone || 'UTC').split('/')[0],
      subjects: profile.subjects,
      topics: profile.topics,
      goals: profile.goals,
      current_goal: profile.current_goal,
      learning_level: profile.learning_level,
      study_style: profile.study_style,
      modes: profile.modes,
      languages: profile.languages,
      cross_subject: profile.cross_subject,
      interests: profile.interests,
      session_duration_minutes: profile.session_duration_minutes,
      completed_sessions: profile.completed_sessions,
      reliability_score: profile.reliability_score
    };
  };
  const videoRoomViewLocal = room => {
    const participantIds = asList(room?.participant_ids);
    const participants = participantIds.map(studySafePersonLocal).filter(Boolean);
    const attendance = Array.isArray(room?.attendance) ? room.attendance.map(record => ({...record, member: participants.find(person => person.id === record.user_id) || null})) : [];
    return {...room, participant_ids: participantIds, participants, attendance, signals: Array.isArray(room?.signals) ? room.signals : [], viewer_is_host: room?.host_id === store.sessionUserId, viewer_is_participant: participantIds.includes(store.sessionUserId), status: room?.status || 'ready'};
  };
  const studyOverlapLocal = (left, right) => {
    const leftWindows = studyAvailabilityLocal(left?.availability);
    const rightWindows = studyAvailabilityLocal(right?.availability);
    for (const first of leftWindows) {
      for (const second of rightWindows) {
        if (first.kind === 'one_off' || second.kind === 'one_off') {
          if (first.date_key !== second.date_key) continue;
        } else if (Number(first.weekday) !== Number(second.weekday)) continue;
        const start = Math.max(studyMinuteLocal(first.start), studyMinuteLocal(second.start));
        const end = Math.min(studyMinuteLocal(first.end), studyMinuteLocal(second.end));
        if (end > start) return {minutes: end - start, label: `Overlaps ${end - start} minutes`};
      }
    }
    return null;
  };
  const studyMatchesLocal = userId => {
    const mine = studyProfileViewLocal(userId);
    if (!mine) return [];
    const mineSubjects = new Set(mine.subjects.map(item => item.toLowerCase()));
    const favorites = new Set(store.study_favorites.filter(item => item.user_id === userId).map(item => item.partner_id));
    return Object.keys(store.study_profiles).filter(candidateId => candidateId !== userId).map(candidateId => {
      const candidateProfile = studyProfileViewLocal(candidateId);
      const person = studySafePersonLocal(candidateId, candidateProfile);
      if (!candidateProfile || !person || candidateProfile.visibility !== 'discoverable') return null;
      const ageCompatible = !mine.age_band || mine.age_band === 'any' || !candidateProfile.age_band || candidateProfile.age_band === 'any' || mine.age_band === candidateProfile.age_band;
      if (!ageCompatible) return null;
      const overlap = studyOverlapLocal(mine, candidateProfile);
      const sharedSubject = candidateProfile.subjects.some(subject => mineSubjects.has(subject.toLowerCase()));
      const sharedMode = mine.modes.some(mode => candidateProfile.modes.includes(mode));
      const durationClose = Math.abs(Number(mine.session_duration_minutes) - Number(candidateProfile.session_duration_minutes)) <= 25;
      const sameStyle = mine.study_style === candidateProfile.study_style;
      const score = Math.min(99, Math.max(38, (overlap ? 30 : 0) + (durationClose ? 20 : 10) + (sameStyle ? 15 : 8) + (sharedMode ? 15 : 6) + (sharedSubject ? 10 : (mine.cross_subject && candidateProfile.cross_subject ? 8 : 4))));
      const reasons = [
        overlap ? `You both have an open window for ${overlap.minutes} minutes.` : 'Add a shared availability window to improve this match.',
        sharedSubject ? `You both listed ${candidateProfile.subjects.find(subject => mineSubjects.has(subject.toLowerCase()))}.` : 'Different subjects are welcome in a shared focus session.'
      ];
      return {id: `study-match-${candidateId}`, candidate: person, score, reasons: reasons.map((explanation, index) => ({label: index ? 'Learning direction' : 'Schedule overlap', points: index ? (sharedSubject ? 10 : 4) : (overlap ? 30 : 0), max_points: index ? 10 : 30, explanation})), top_reasons: reasons, subject_overlap: sharedSubject, availability: {available_now: false, next_overlap_at: null, label: overlap?.label || 'Schedule not shared'}, saved: favorites.has(candidateId)};
    }).filter(Boolean).sort((left, right) => right.score - left.score).slice(0, 24);
  };
  const studyRoomViewLocal = room => {
    const members = Array.isArray(room?.members) ? room.members : [];
    const participants = members.map(member => {
      const person = studySafePersonLocal(member.user_id);
      return person ? {...person, role: member.role, member_status: member.status, status: member.status, joined_at: member.joined_at || null} : null;
    }).filter(Boolean);
    return {...room, max_participants: Number(room.max_participants || 4), duration_minutes: studyDurationLocal(room.duration_minutes), modes: studyModesLocal(room.modes).length ? studyModesLocal(room.modes) : ['focus'], pomodoro: room.pomodoro || {focus: studyDurationLocal(room.duration_minutes), break: 10, rounds: 1}, rules: studyListLocal(room.rules, 6), participant_count: participants.filter(person => person.member_status === 'active').length, participants};
  };
  const studySessionViewLocal = session => {
    if (!session) return null;
    const room = store.study_rooms.find(item => item.id === session.room_id);
    const participants = (Array.isArray(session.participants) ? session.participants : []).map(member => {
      const person = studySafePersonLocal(member.user_id);
      return person ? {...person, role: member.role, status: member.status, goal: member.goal || '', goal_completed: Boolean(member.goal_completed), progress_note: member.progress_note || '', joined_at: member.joined_at || null, left_at: member.left_at || null} : null;
    }).filter(Boolean);
    return {...session, goal: session.goal || {}, pomodoro: session.pomodoro || {focus: studyDurationLocal(session.duration_minutes), break: 10, rounds: 1}, participants, room: room ? {id: room.id, title: room.title, visibility: room.visibility, subject: room.subject, host_id: room.host_id, video_room_id: session.video_room_id || null} : null};
  };
  const studyCreateRoomLocal = (owner, input = {}) => {
    const starts = new Date(input.starts_at || Date.now() + 5 * 60_000);
    const duration = studyDurationLocal(input.duration_minutes);
    const roomId = id('study_room');
    const sessionId = id('study_session');
    const createdAt = now();
    const member = {user_id: owner.id, role: 'host', status: 'active', goal: String(input.goal || '').trim(), goal_completed: false, progress_note: '', joined_at: createdAt, created_at: createdAt, updated_at: createdAt};
    const room = {id: roomId, host_id: owner.id, title: String(input.title || 'Quiet study room').trim().slice(0, 140) || 'Quiet study room', description: String(input.description || '').trim().slice(0, 800), visibility: studyVisibilityLocal(input.visibility), subject: String(input.subject || '').trim().slice(0, 120), max_participants: Math.max(2, Math.min(8, Number(input.max_participants || 4))), starts_at: starts.toISOString(), duration_minutes: duration, study_style: studyStyleLocal(input.study_style), modes: studyModesLocal(input.modes).length ? studyModesLocal(input.modes) : ['focus'], pomodoro: {focus: duration, break: 10, rounds: 1}, rules: studyListLocal(input.rules, 6), status: 'open', members: [{user_id: owner.id, role: 'host', status: 'active', joined_at: createdAt}], created_at: createdAt, updated_at: createdAt};
    const session = {id: sessionId, room_id: roomId, created_by: owner.id, starts_at: starts.toISOString(), ends_at: new Date(starts.getTime() + duration * 60_000).toISOString(), status: 'scheduled', mode: studyModeLocal(input.mode || (room.modes.includes('video') ? 'video' : room.modes.includes('audio') ? 'audio' : 'focus')), study_style: room.study_style, goal: {subject: room.subject, goal: String(input.goal || '').trim().slice(0, 300)}, duration_minutes: duration, pomodoro: room.pomodoro, video_room_id: null, participants: [member], created_at: createdAt, updated_at: createdAt};
    store.study_rooms.unshift(room);
    store.study_sessions.unshift(session);
    return {room: studyRoomViewLocal(room), session: studySessionViewLocal(session)};
  };
  const studyInvitationViewLocal = invitation => ({...invitation, duration_minutes: studyDurationLocal(invitation.duration_minutes), sender: studySafePersonLocal(invitation.sender_id), recipient: studySafePersonLocal(invitation.recipient_id), is_incoming: invitation.recipient_id === store.sessionUserId});
  const studyOverviewLocal = userId => {
    const profile = studyProfileViewLocal(userId);
    const invitations = store.study_invitations.filter(item => item.sender_id === userId || item.recipient_id === userId).filter(item => ['pending', 'countered', 'accepted'].includes(item.status)).sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at))).slice(0, 20).map(studyInvitationViewLocal);
    const upcoming = store.study_sessions.filter(session => session.participants.some(member => member.user_id === userId) && ['scheduled', 'active'].includes(session.status) && new Date(session.ends_at).getTime() >= Date.now()).sort((left, right) => new Date(left.starts_at) - new Date(right.starts_at)).slice(0, 12).map(studySessionViewLocal);
    const lobby = store.study_rooms.filter(room => room.status === 'open' && room.visibility === 'public' && room.starts_at && new Date(room.starts_at).getTime() <= Date.now() + 86_400_000 && new Date(room.starts_at).getTime() >= Date.now() - 30 * 60_000).slice(0, 16).map(studyRoomViewLocal);
    const completed = store.study_sessions.filter(session => session.participants.some(member => member.user_id === userId && member.status === 'completed') && session.status === 'completed');
    const minutes = completed.reduce((total, session) => total + Math.round((new Date(session.ends_at).getTime() - new Date(session.starts_at).getTime()) / 60_000), 0);
    const goals = completed.reduce((total, session) => total + (session.participants.some(member => member.user_id === userId && member.goal_completed) ? 1 : 0), 0);
    return {ok: true, server_time: now(), profile, onboarding_complete: Boolean(profile && profile.subjects.length && profile.current_goal), invitations, upcoming_sessions: upcoming, lobby, matches: profile ? studyMatchesLocal(userId) : [], stats: {sessions_completed: completed.length, study_minutes: Math.max(0, minutes), goals_completed: goals}};
  };

  async function route(resource, init = {}) {
    const requestUrl = typeof resource === 'string' ? resource : resource.url;
    const url = new URL(requestUrl, location.origin);
    const path = url.pathname;
    const method = String(init.method || (resource instanceof Request ? resource.method : 'GET') || 'GET').toUpperCase();
    syncStore();
    if (consolidateDirectConversations()) persist();
    const body = await readBody(resource, init);
    const user = current();
    if (user?.profile) applyAutomaticTimezone(user.profile);

    const profileGatedWrite = ['POST', 'PATCH', 'PUT'].includes(method) && (
      path === '/api/workshops' ||
      /^\/api\/workshops\/[^/]+\/register$/.test(path) || path === '/api/calendar/events' ||
      path === '/api/livestreams' || /^\/api\/livestreams\/[^/]+\/(?:start|join|chat|signals)$/.test(path) ||
      path === '/api/ideas' || /^\/api\/ideas\/[^/]+\/(?:like|save|comments)(?:\/[^/]+)?$/.test(path) || path === '/api/journal' || /^\/api\/journal\/[^/]+$/.test(path) ||
      path === '/api/portfolio' || /^\/api\/portfolio\/items(?:\/[^/]+)?$/.test(path) ||
      path === '/api/gifts/vouchers' || path === '/api/gifts/vouchers/redeem' || path === '/api/swapjobs' ||
      path === '/api/organizations/register' || path === '/api/organizations/members' || path === '/api/organizations/policy' ||
      path === '/api/community/posts' || path === '/api/community/stories' ||
      /^\/api\/community\/posts\/[^/]+\/(?:like|share|comments)$/.test(path) ||
      /^\/api\/community\/groups\/[^/]+\/join$/.test(path)
    );
    if (profileGatedWrite) {
      const returnTo = path === '/api/matches' || path === '/api/swaps' ? 'skill-matching.html?intent=swap' :
        path.includes('/api/ideas') ? 'skill-innovation.html' : path.includes('inbox') ? 'notifications.html' : path.includes('workshop') ? 'workshops.html' :
          path.includes('calendar') ? 'calendar.html' : path.includes('portfolio') ? 'portfolio.html' : 'dashboard.html';
      const completionGate = profileCompletionGate(user, returnTo);
      if (completionGate) return completionGate;
    }

    if (path === '/api/auth/google/status' && method === 'GET') {
      return response({enabled: false, provider: 'google', linked: false, provider_email: '', message: 'Google sign-in is available on the published website after OAuth setup.'});
    }
    if (path === '/api/auth/google/start' && method === 'GET') {
      return failure('Google sign-in is not available in local preview mode. Use the published website after Google OAuth is configured.', 503);
    }
    if (path === '/api/auth/google/callback' && method === 'GET') {
      return failure('Google sign-in could not be completed in local preview mode.', 400);
    }
    if (path === '/api/auth/csrf' && method === 'GET') return response({csrf_token: CSRF});
    if (path === '/api/auth/me' && method === 'GET') return response({authenticated: Boolean(user), user: accountUser(user), csrf_token: CSRF});
    if (path === '/api/presence/heartbeat' && method === 'POST') {
      const denied = requireUser(); if (denied) return denied;
      if (user.status !== 'active') return failure('This account is not active.', 403);
      const seenAt = now();
      const page = safePresencePage(body.page);
      store.presence ||= {};
      store.presence_days ||= {};
      store.presence[user.id] = {user_id: user.id, last_seen_at: seenAt, page_path: page, updated_at: seenAt};
      const dayKey = seenAt.slice(0, 10);
      store.presence_days[user.id + ':' + dayKey] = {user_id: user.id, day_key: dayKey, last_seen_at: seenAt, page_path: page, updated_at: seenAt};
      const cutoff = Date.now() - ONLINE_PRESENCE_WINDOW_SECONDS * 1000;
      Object.entries(store.presence).forEach(([userId, record]) => {
        if (!record || Date.parse(record.last_seen_at) < cutoff) delete store.presence[userId];
      });
      const historyCutoff = Date.now() - ONLINE_PRESENCE_HISTORY_SECONDS * 1000;
      Object.entries(store.presence_days).forEach(([key, record]) => {
        if (!record || Date.parse(record.last_seen_at) < historyCutoff) delete store.presence_days[key];
      });
      persist();
      return response({ok: true, last_seen_at: seenAt, active_window_seconds: ONLINE_PRESENCE_WINDOW_SECONDS});
    }

    if (path === '/api/study' && method === 'GET') {
      const denied = requireUser(); if (denied) return denied;
      return response(studyOverviewLocal(user.id));
    }
    if (path === '/api/study/profile' && ['GET', 'PUT', 'PATCH'].includes(method)) {
      const denied = requireUser(); if (denied) return denied;
      if (method === 'GET') return response({profile: studyProfileViewLocal(user.id)});
      const existing = studyProfileForLocal(user.id) || {};
      const availability = studyAvailabilityLocal(body.availability !== undefined ? body.availability : existing.availability);
      const modes = studyModesLocal(body.modes !== undefined ? body.modes : existing.modes);
      const languages = studyListLocal(body.languages !== undefined ? body.languages : existing.languages, 8);
      const saved = {
        ...existing,
        user_id: user.id,
        status: 'active',
        visibility: body.visibility === 'private' ? 'private' : 'discoverable',
        subjects: studyListLocal(body.subjects !== undefined ? body.subjects : existing.subjects, 12),
        topics: studyListLocal(body.topics !== undefined ? body.topics : existing.topics, 20),
        goals: studyListLocal(body.goals !== undefined ? body.goals : existing.goals, 8),
        learning_level: String(body.learning_level || existing.learning_level || 'all_levels'),
        timezone: String(body.timezone || existing.timezone || user.profile?.timezone || deviceTimezone()),
        session_duration_minutes: studyDurationLocal(body.session_duration_minutes || existing.session_duration_minutes),
        study_style: studyStyleLocal(body.study_style || existing.study_style),
        modes: modes.length ? modes : ['focus'],
        languages: languages.length ? languages : ['English'],
        interests: studyListLocal(body.interests !== undefined ? body.interests : existing.interests, 12),
        cross_subject: body.cross_subject === false ? false : existing.cross_subject !== false,
        age_band: String(body.age_band || existing.age_band || 'any'),
        current_goal: String(body.current_goal !== undefined ? body.current_goal : existing.current_goal || '').trim().slice(0, 300),
        reliability_score: Number(existing.reliability_score || 0),
        completed_sessions: Number(existing.completed_sessions || 0),
        availability,
        created_at: existing.created_at || now(),
        updated_at: now()
      };
      store.study_profiles[user.id] = saved;
      store.study_availability[user.id] = availability;
      persist();
      return response({message: 'Study profile saved.', profile: studyProfileViewLocal(user.id)});
    }
    if (path === '/api/study/matches' && method === 'GET') {
      const denied = requireUser(); if (denied) return denied;
      return response({matches: studyMatchesLocal(user.id)});
    }
    if (path === '/api/study/invitations' && ['GET', 'POST'].includes(method)) {
      const denied = requireUser(); if (denied) return denied;
      if (method === 'GET') return response({invitations: store.study_invitations.filter(item => item.sender_id === user.id || item.recipient_id === user.id).map(studyInvitationViewLocal)});
      const targetId = String(body.target_user_id || '').trim();
      const target = findUser(targetId);
      if (!target || target.id === user.id || !studyProfileForLocal(target.id)) return failure('That study partner is not available.', 404);
      const proposed = new Date(body.proposed_start_utc || Date.now() + 60 * 60 * 1000);
      if (Number.isNaN(proposed.getTime())) return failure('Choose a valid session start time.');
      const invitation = {id: id('study_invitation'), sender_id: user.id, recipient_id: target.id, proposed_start_utc: proposed.toISOString(), duration_minutes: studyDurationLocal(body.duration_minutes), mode: studyModeLocal(body.mode), study_style: studyStyleLocal(body.study_style || studyProfileViewLocal(user.id)?.study_style), message: String(body.message || '').trim().slice(0, 600), status: 'pending', created_at: now(), updated_at: now()};
      store.study_invitations.unshift(invitation);
      notification(target.id, 'study_invitation', `${user.profile?.display_name || user.username} invited you to a Study Together session.`, invitation.id);
      persist();
      return response({message: 'Study invitation sent.', invitation: studyInvitationViewLocal(invitation)}, 201);
    }
    const studyInvitationPath = path.match(/^\/api\/study\/invitations\/([^/]+)$/);
    if (studyInvitationPath && method === 'PATCH') {
      const denied = requireUser(); if (denied) return denied;
      const invitation = store.study_invitations.find(item => item.id === decodeURIComponent(studyInvitationPath[1]) && (item.sender_id === user.id || item.recipient_id === user.id));
      if (!invitation) return failure('Study invitation not found.', 404);
      const action = String(body.action || '').trim();
      if (action === 'decline') {
        invitation.status = 'declined'; invitation.updated_at = now();
        notification(invitation.sender_id, 'study_invitation_declined', 'Your Study Together invitation was declined.', invitation.id);
        persist(); return response({message: 'Invitation declined.', invitation: studyInvitationViewLocal(invitation)});
      }
      if (action === 'counter') {
        const proposed = new Date(body.proposed_start_utc || '');
        if (Number.isNaN(proposed.getTime())) return failure('Choose a valid counter-proposal time.');
        invitation.counter_start_utc = proposed.toISOString(); invitation.counter_duration_minutes = studyDurationLocal(body.duration_minutes); invitation.status = 'countered'; invitation.updated_at = now();
        notification(invitation.sender_id, 'study_invitation_countered', 'Your Study Together invitation has a new time proposal.', invitation.id);
        persist(); return response({message: 'Counter-proposal sent.', invitation: studyInvitationViewLocal(invitation)});
      }
      if (action === 'accept' || action === 'accept_counter') {
        const start = new Date(action === 'accept_counter' && invitation.counter_start_utc ? invitation.counter_start_utc : invitation.proposed_start_utc);
        const duration = studyDurationLocal(action === 'accept_counter' ? invitation.counter_duration_minutes : invitation.duration_minutes);
        const created = studyCreateRoomLocal(user, {title: `Study Together · ${studyProfileViewLocal(invitation.sender_id)?.subjects?.[0] || 'shared focus'}`, starts_at: start.toISOString(), duration_minutes: duration, visibility: 'invite_only', subject: studyProfileViewLocal(invitation.sender_id)?.subjects?.[0] || '', goal: studyProfileViewLocal(user.id)?.current_goal || '', modes: [invitation.mode], rules: ['Respect the shared focus block.', 'Cameras and microphones are always optional.']});
        const room = store.study_rooms.find(item => item.id === created.room.id);
        const session = store.study_sessions.find(item => item.id === created.session.id);
        const other = {user_id: invitation.sender_id, role: 'participant', status: 'scheduled', goal: studyProfileViewLocal(invitation.sender_id)?.current_goal || '', goal_completed: false, progress_note: '', joined_at: null, created_at: now(), updated_at: now()};
        room.members.push({user_id: invitation.sender_id, role: 'participant', status: 'active', joined_at: now()});
        session.participants.push(other);
        invitation.status = 'accepted'; invitation.updated_at = now();
        notification(invitation.sender_id, 'study_invitation_accepted', 'Your Study Together session is confirmed.', session.id);
        persist(); return response({status: 'accepted', session: studySessionViewLocal(session)}, 201);
      }
      return failure('That invitation action is not available.');
    }
    if (path === '/api/study/rooms' && ['GET', 'POST'].includes(method)) {
      const denied = requireUser(); if (denied) return denied;
      if (method === 'GET') {
        const rooms = store.study_rooms.filter(room => (room.visibility === 'public' && room.status === 'open') || room.host_id === user.id || room.members?.some(member => member.user_id === user.id)).map(studyRoomViewLocal);
        return response({rooms});
      }
      const starts = new Date(body.starts_at || Date.now() + 5 * 60_000);
      if (Number.isNaN(starts.getTime())) return failure('Choose a valid room start time.');
      const created = studyCreateRoomLocal(user, body);
      persist(); return response(created, 201);
    }
    const studyRoomPath = path.match(/^\/api\/study\/rooms\/([^/]+)(?:\/(join|leave|lock))?$/);
    if (studyRoomPath && ['GET', 'POST', 'PATCH'].includes(method)) {
      const denied = requireUser(); if (denied) return denied;
      const room = store.study_rooms.find(item => item.id === decodeURIComponent(studyRoomPath[1]));
      const action = studyRoomPath[2] || 'detail';
      if (!room) return failure('Study room not found.', 404);
      const membership = (room.members || []).find(member => member.user_id === user.id);
      if (action === 'detail' && method === 'GET') {
        if (!membership && room.visibility !== 'public') return failure('This room is private.', 403);
        return response({room: studyRoomViewLocal(room)});
      }
      if (action === 'join' && method === 'POST') {
        if (room.status !== 'open') return failure('This study room is no longer open.', 409);
        if (!membership && room.visibility !== 'public') return failure('This room is invite-only.', 403);
        if (!membership && (room.members || []).filter(member => member.status === 'active').length >= Number(room.max_participants || 4)) return failure('This room is full.', 409);
        if (!membership) room.members.push({user_id: user.id, role: 'participant', status: 'active', joined_at: now()});
        else { membership.status = 'active'; membership.joined_at = now(); }
        const session = store.study_sessions.find(item => item.room_id === room.id);
        if (session && !session.participants.some(member => member.user_id === user.id)) session.participants.push({user_id: user.id, role: 'participant', status: 'scheduled', goal: studyProfileViewLocal(user.id)?.current_goal || '', goal_completed: false, progress_note: '', joined_at: null, created_at: now(), updated_at: now()});
        if (room.host_id !== user.id) notification(room.host_id, 'study_room_joined', `${user.profile?.display_name || user.username} joined your Study Together room.`, room.id);
        persist(); return response({room: studyRoomViewLocal(room)});
      }
      if (action === 'leave' && method === 'POST') {
        if (membership) membership.status = 'left';
        const session = store.study_sessions.find(item => item.room_id === room.id); const sessionMember = session?.participants.find(member => member.user_id === user.id); if (sessionMember && sessionMember.status !== 'completed') sessionMember.status = 'left';
        persist(); return response({message: 'You left the study room.'});
      }
      if (action === 'lock' && method === 'PATCH') {
        if (room.host_id !== user.id) return failure('Only the host can lock a room.', 403);
        room.status = body.locked === false ? 'open' : 'locked'; room.updated_at = now(); persist(); return response({room: studyRoomViewLocal(room)});
      }
    }
    if (path === '/api/study/sessions' && method === 'GET') {
      const denied = requireUser(); if (denied) return denied;
      return response({sessions: store.study_sessions.filter(session => session.participants.some(member => member.user_id === user.id)).sort((left, right) => new Date(right.starts_at) - new Date(left.starts_at)).slice(0, 80).map(studySessionViewLocal)});
    }
    const studySessionPath = path.match(/^\/api\/study\/sessions\/([^/]+)(?:\/(messages|complete|leave|video-room))?$/);
    if (studySessionPath && ['GET', 'POST', 'PATCH'].includes(method)) {
      const denied = requireUser(); if (denied) return denied;
      const session = store.study_sessions.find(item => item.id === decodeURIComponent(studySessionPath[1]) && item.participants.some(member => member.user_id === user.id));
      const action = studySessionPath[2] || 'detail';
      if (!session) return failure('Study session not found.', 404);
      if (action === 'detail' && method === 'GET') return response({session: studySessionViewLocal(session)});
      if (action === 'video-room' && method === 'POST') {
        const mediaMode = ['video', 'audio'].includes(String(body.mode)) ? String(body.mode) : String(session.mode);
        if (!['video', 'audio'].includes(mediaMode)) return failure('Choose video or audio before opening the protected room.');
        if (session.video_room_id) {
          const existingRoom = store.video_rooms.find(item => item.id === session.video_room_id);
          if (existingRoom) return response({room: videoRoomViewLocal(existingRoom), session: studySessionViewLocal(session)});
        }
        const participantIds = session.participants.filter(member => member.status !== 'left').map(member => member.user_id);
        const roomId = id('room'); const hostId = session.created_by || participantIds[0] || user.id; const createdAt = now();
        const room = {id: roomId, owner_id: hostId, host_id: hostId, title: String(body.title || store.study_rooms.find(item => item.id === session.room_id)?.title || 'SwapLabs Study Together room').slice(0, 180), status: 'ready', waiting_room_enabled: true, screen_sharing_enabled: mediaMode === 'video', video_enabled: mediaMode === 'video', audio_enabled: true, call_mode: mediaMode === 'audio' ? 'voice' : 'video', participant_ids: [...new Set(participantIds)], attendance: [...new Set(participantIds)].map(userId => ({user_id: userId, state: userId === hostId ? 'admitted' : 'invited', joined_at: null, left_at: null, duration_seconds: 0, participant_confirmed: false, host_confirmed: userId === hostId})), signals: [], created_at: createdAt};
        store.video_rooms.unshift(room); session.video_room_id = roomId; session.mode = mediaMode; session.updated_at = createdAt; persist();
        return response({room: videoRoomViewLocal(room), session: studySessionViewLocal(session)}, 201);
      }
      if (action === 'messages' && method === 'GET') return response({messages: store.study_messages.filter(message => message.session_id === session.id).slice(-80)});
      if (action === 'messages' && method === 'POST') {
        const text = String(body.body || '').trim().slice(0, 1200); if (!text) return failure('Write a message first.');
        const message = {id: id('study_message'), session_id: session.id, user_id: user.id, display_name: user.profile?.display_name || user.username, body: text, kind: ['chat', 'check_in', 'resource'].includes(body.kind) ? body.kind : 'chat', metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {}, created_at: now()};
        store.study_messages.push(message); session.participants.filter(member => member.user_id !== user.id && ['active', 'scheduled'].includes(member.status)).forEach(member => notification(member.user_id, 'study_message', 'You have a new Study Together message.', session.id)); persist(); return response({message}, 201);
      }
      const member = session.participants.find(item => item.user_id === user.id);
      if (action === 'complete' && method === 'POST') {
        if (member.status !== 'completed') { member.status = 'completed'; member.goal_completed = body.goal_completed !== false; member.progress_note = String(body.progress_note || '').trim().slice(0, 600); member.left_at = now(); const profile = studyProfileForLocal(user.id); if (profile) profile.completed_sessions = Number(profile.completed_sessions || 0) + 1; }
        const remaining = session.participants.some(item => !['completed', 'left'].includes(item.status)); session.status = remaining ? 'active' : 'completed'; session.updated_at = now(); persist(); return response({session: studySessionViewLocal(session)});
      }
      if (action === 'leave' && method === 'POST') { if (member.status !== 'completed') member.status = 'left'; session.updated_at = now(); persist(); return response({ok: true}); }
      if (action === 'detail' && method === 'PATCH') { if (body.goal !== undefined) member.goal = String(body.goal || '').trim().slice(0, 300); if (body.progress_note !== undefined) member.progress_note = String(body.progress_note || '').trim().slice(0, 600); session.goal.goal = member.goal; session.updated_at = now(); persist(); return response({session: studySessionViewLocal(session)}); }
    }
    const studyFavoritePath = path.match(/^\/api\/study\/favorites\/([^/]+)$/);
    if (studyFavoritePath && ['POST', 'DELETE'].includes(method)) {
      const denied = requireUser(); if (denied) return denied;
      const partnerId = decodeURIComponent(studyFavoritePath[1]);
      store.study_favorites = store.study_favorites.filter(item => !(item.user_id === user.id && item.partner_id === partnerId));
      if (method === 'POST') store.study_favorites.push({id: id('study_favorite'), user_id: user.id, partner_id: partnerId, created_at: now()});
      persist(); return response({saved: method === 'POST'});
    }
    if (path === '/api/study/reports' && method === 'POST') {
      const denied = requireUser(); if (denied) return denied;
      store.study_reports.push({id: id('study_report'), reporter_id: user.id, target_user_id: body.target_user_id || '', room_id: body.room_id || '', session_id: body.session_id || '', reason: String(body.reason || 'other'), details: String(body.details || '').slice(0, 1000), status: 'open', created_at: now()});
      persist(); return response({message: 'Thanks. The report is private and has been sent to moderation.'}, 201);
    }
    if (path === '/api/auth/logout' && method === 'POST') { if (user?.id) delete store.presence?.[user.id]; store.sessionUserId = ''; persist(); return response({ok: true, message: 'You are signed out.'}); }
    if (path === '/api/auth/username-availability' && method === 'GET') {
      const username = String(url.searchParams.get('username') || '').trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,30}$/.test(username)) return response({available: false, reason: 'invalid', username});
      const taken = store.users.some(item => String(item.username || '').trim().toLowerCase() === username);
      return response({available: !taken, reason: taken ? 'taken' : 'available', username});
    }
    if (path === '/api/auth/register' && method === 'POST') {
      const username = String(body.username || '').trim().toLowerCase();
      const contact = String(body.contact || body.email || '').trim();
      const emailContact = /^\S+@\S+\.\S+$/.test(contact) ? contact.toLowerCase() : '';
      const phoneContact = emailContact ? '' : contact;
      const phoneDigits = phoneContact.replace(/\D/g, '');
      if (!username || !contact || !body.password) return failure('Add a name, username, email or phone number, and password to create your account.');
      if (!emailContact && (phoneDigits.length < 7 || phoneDigits.length > 15)) return failure('Enter a valid email address or phone number.');
      const email = emailContact || `phone-${phoneDigits}@accounts.relayskills.local`;
      if (store.users.some(item => String(item.username || '').toLowerCase() === username)) return failure('That username is already taken. Try another username.', 409, {code: 'username_taken'});
      if (emailContact && store.users.some(item => String(item.email || '').toLowerCase() === email)) return failure('That email address is already registered. Try another email or sign in.', 409, {code: 'email_taken'});
      if (phoneContact && store.users.some(item => String(item.profile?.phone_number || '').replace(/\D/g, '') === phoneDigits)) return failure('That phone number is already registered. Try another number or sign in.', 409, {code: 'phone_taken'});
      const suppliedFullName = String(body.full_name || body.profile?.display_name || '').trim();
      if (!suppliedFullName) return failure('Enter your full name.');
      const profile = {...profileDefaults(), ...(body.profile || {})};
      applyAutomaticTimezone(profile);
      profile.display_name = profile.display_name || body.full_name || [profile.first_name, profile.last_name].filter(Boolean).join(' ') || username;
      if (!profile.first_name || !profile.last_name) {
        const parts = String(profile.display_name).trim().split(/\s+/).filter(Boolean);
        profile.first_name ||= parts.shift() || '';
        profile.last_name ||= parts.join(' ');
      }
      if (!validName(profile.display_name, 'display_name') || !validName(profile.first_name, 'first_name') || !validName(profile.last_name, 'last_name')) return failure(nameFormatMessage);
      if (phoneContact) profile.phone_number = phoneContact;
      const safety = localSafety(body.safety, profile);
      if (!String(profile.date_of_birth || '').trim()) return failure('Enter your date of birth so we can apply the correct safety settings.');
      const age = Number(profile.age);
      if (!Number.isFinite(age) || age < 3 || age > 120) return failure('SwapLabs accounts are available for ages 3–120.');
      if (safety.is_minor && (!safety.guardian_name || !safety.guardian_email || !safety.guardian_relationship || !safety.guardian_consent_declared)) {
        return failure('A parent or guardian must provide consent for children under 13.');
      }
      const preferences = {...preferencesDefaults(), ...(body.preferences || {})};
      if (safety.is_minor) preferences.show_location = false;
      const created = {id: id('usr'), username, email, password_hash: await hash(body.password), role: 'member', status: 'active', verified: false, time_credits: 30, reward_points: 0, profile, preferences, safety, created_at: now()};
      store.users.push(created);
      ensureLocalStreak(created.id);
      withSession(created); persist();
      return response({message: 'Your SwapLabs account is ready.', user: accountUser(created), csrf_token: CSRF});
    }
    if (path === '/api/auth/login' && method === 'POST') {
      const login = String(body.login || body.admin_id || '').trim().toLowerCase();
      const loginPhone = login.replace(/\D/g, '');
      const candidate = store.users.find(item => item.username === login || item.email === login || item.profile?.phone_number === login || (loginPhone && String(item.profile?.phone_number || '').replace(/\D/g, '') === loginPhone));
      if (!candidate || (body.password && candidate.password_hash !== await hash(body.password))) return failure('We could not sign you in with those details.', 401);
      withSession(candidate); return response({message: `Welcome back, ${candidate.profile.display_name || candidate.username}.`, user: accountUser(candidate), csrf_token: CSRF});
    }
    if (path === '/api/auth/admin-gate' && method === 'POST') {
      const code = String(body.code || '').trim();
      if (code !== '********') return failure('That operations code was not accepted.', 401);
      let admin = store.users.find(item => item.role === 'admin');
      if (!admin) {
        admin = {id: id('usr'), username: 'operations', email: 'support.swaplabs@gmail.com', password_hash: await hash(code), role: 'admin', status: 'active', verified: true, time_credits: 0, reward_points: 0, profile: {...profileDefaults(), display_name: 'SwapLabs operations', first_name: 'SwapLabs', last_name: 'Operations', headline: 'Trust and safety workspace'}, preferences: preferencesDefaults(), safety: {account_type: 'adult', is_minor: false, guardian_consent_status: 'not_applicable', innovation_access: 'standard'}, created_at: now()};
        store.users.push(admin);
      }
      withSession(admin); return response({message: 'Operations workspace unlocked.', user: accountUser(admin), csrf_token: CSRF});
    }
    if (path === '/api/public/content' && method === 'GET') {
      const content = publicContent();
      return response({...content, groups: store.groups, workshops: store.workshops.filter(item => item.status !== 'cancelled'), ideas: store.ideas});
    }
    if (path === '/api/platform/metrics' && method === 'GET') {
      const liveMetrics = metrics();
      return response({metrics: {...liveMetrics, updated_at: now()}, skill_names: liveMetrics.skill_names});
    }
    if (path === '/api/testimonials' && method === 'GET') return response({testimonials: store.feedback.filter(item => item.publication_permission)});
    if (path === '/api/leaderboard' && method === 'GET') return response({leaders: [], entries: [], leaderboard: [], stats: {total_credits: 0}});
    if (path === '/api/community' && method === 'GET') {
      const users = store.users.map(publicUser);
      const visibleCountries = new Set(users.filter(item => item.visibility !== 'private').map(item => item.profile?.country).filter(Boolean));
      return response({
        users,
        groups: store.groups,
        feed: store.posts,
        viewer: accountUser(user),
        stats: {
          total: users.length,
          public: users.filter(item => item.visibility !== 'private').length,
          private: users.filter(item => item.visibility === 'private').length,
          countries: visibleCountries.size,
          skills: [...new Set(users.flatMap(item => asList(item.profile?.skills_to_teach)))].length,
          published_ideas: store.ideas.filter(item => item.status === 'published').length,
          posts: store.posts.length,
          groups: store.groups.length
        }
      });
    }
    if (path === '/api/community/groups' && method === 'GET') return response({groups: store.groups.map(group => communityGroupView(group, user?.id))});
    const groupJoinMatch = path.match(/^\/api\/community\/groups\/([^/]+)\/join$/);
    if (groupJoinMatch && ['POST', 'DELETE'].includes(method)) {
      const denied = requireUser(); if (denied) return denied;
      const group = store.groups.find(item => item.id === decodeURIComponent(groupJoinMatch[1]));
      if (!group) return failure('That community group is no longer available.', 404);
      group.member_ids = Array.isArray(group.member_ids) ? group.member_ids : [];
      group.moderator_ids = Array.isArray(group.moderator_ids) ? group.moderator_ids : (group.owner_id ? [group.owner_id] : []);
      group.pending_join_requests = Array.isArray(group.pending_join_requests) ? group.pending_join_requests : [];
      const existingRequest = group.pending_join_requests.find(item => item.user_id === user.id && (item.status || 'pending') === 'pending');
      if (method === 'DELETE') {
        if (group.owner_id === user.id) return failure('The group creator cannot leave this community group.');
        group.member_ids = group.member_ids.filter(memberId => memberId !== user.id);
        group.pending_join_requests = group.pending_join_requests.filter(item => item.user_id !== user.id);
        groupConversation(group);
        persist();
        return response({message: `You left ${group.title}.`, group: communityGroupView(group, user.id)});
      }
      if (group.member_ids.includes(user.id)) return response({message: `You are already in ${group.title}.`, group: communityGroupView(group, user.id)});
      if (group.requires_approval) {
        if (!existingRequest) group.pending_join_requests.push({id: id('group-request'), user_id: user.id, status: 'pending', created_at: now(), updated_at: now()});
        persist();
        return response({message: 'Your request to join is waiting for a moderator.', group: communityGroupView(group, user.id)});
      }
      group.member_ids.push(user.id);
      groupConversation(group);
      group.moderator_ids.filter(memberId => memberId !== user.id).forEach(memberId => notification(memberId, 'community_group_joined', `${user.profile.display_name || user.username} joined ${group.title}.`, group.id));
      persist();
      return response({message: `You joined ${group.title}.`, group: communityGroupView(group, user.id)});
    }
    const groupRequestMatch = path.match(/^\/api\/community\/groups\/([^/]+)\/join-requests\/([^/]+)$/);
    if (groupRequestMatch && method === 'POST') {
      const denied = requireUser(); if (denied) return denied;
      const group = store.groups.find(item => item.id === decodeURIComponent(groupRequestMatch[1]));
      const memberId = decodeURIComponent(groupRequestMatch[2]);
      if (!group) return failure('That community group is no longer available.', 404);
      const moderators = Array.isArray(group.moderator_ids) ? group.moderator_ids : (group.owner_id ? [group.owner_id] : []);
      if (!moderators.includes(user.id)) return failure('Only community moderators can review join requests.', 403);
      const requestItem = (group.pending_join_requests || []).find(item => item.user_id === memberId && (item.status || 'pending') === 'pending');
      if (!requestItem) return failure('That join request is no longer pending.', 404);
      if (body.approve === true || body.approve === 'true') {
        group.member_ids = Array.isArray(group.member_ids) ? group.member_ids : [];
        if (!group.member_ids.includes(memberId)) group.member_ids.push(memberId);
        groupConversation(group);
        requestItem.status = 'approved';
        notification(memberId, 'community_group_join_approved', `Your request to join ${group.title} was approved.`, group.id);
        persist();
        return response({message: 'Member approved.', group: communityGroupView(group, user.id)});
      }
      requestItem.status = 'declined';
      notification(memberId, 'community_group_join_declined', `Your request to join ${group.title} was declined.`, group.id);
      persist();
      return response({message: 'Join request declined.', group: communityGroupView(group, user.id)});
    }
    const followMatch = path.match(/^\/api\/community\/users\/([^/]+)\/follow$/);
    if (followMatch && ['POST', 'DELETE'].includes(method)) {
      const denied = requireUser(); if (denied) return denied;
      const target = findUser(decodeURIComponent(followMatch[1]));
      if (!target || target.role === 'admin' || target.status !== 'active') return failure('That member profile is not available.', 404);
      if (target.id === user.id) return failure('You cannot follow your own profile.');
      store.follows = Array.isArray(store.follows) ? store.follows : [];
      const existing = store.follows.find(item => item.follower_id === user.id && item.following_id === target.id);
      if (method === 'POST' && !existing) {
        store.follows.push({id: id('follow'), follower_id: user.id, following_id: target.id, created_at: now()});
        notification(target.id, 'new_follower', `${user.profile.display_name || user.username} followed you.`, user.id);
      }
      if (method === 'DELETE') store.follows = store.follows.filter(item => !(item.follower_id === user.id && item.following_id === target.id));
      persist();
      return response({message: method === 'POST' ? `You are now following ${target.profile.display_name || target.username}.` : `You unfollowed ${target.profile.display_name || target.username}.`, relationship: profileRelationship(user.id, target.id), user: publicUser(target)});
    }
    const memberPortfolioMatch = path.match(/^\/api\/community\/users\/([^/]+)\/portfolio$/);
    if (memberPortfolioMatch && method === 'GET') {
      const target = findUser(decodeURIComponent(memberPortfolioMatch[1]));
      if (!target || !['member', 'admin'].includes(target.role) || target.status !== 'active') return failure('That member profile is not available.', 404);
      return response({portfolio: memberPortfolioView(target, user?.id)});
    }
    if (path === '/api/members' && method === 'GET') return response({members: store.users.map(publicUser), users: store.users.map(publicUser)});
    if (path === '/api/community/feed' && method === 'GET') return response({viewer: accountUser(user), posts: store.posts, stories: store.stories.filter(item => new Date(item.expires_at).getTime() > Date.now()), discover: store.users.filter(item => item.id !== user?.id).map(publicUser)});
    if (path === '/api/blog/feed' && method === 'GET') {
      const sort = url.searchParams.get('sort') || 'latest';
      const visible = (store.blogs || []).filter(post => post.status !== 'draft' && post.visibility !== 'private' && (post.visibility !== 'followers' || post.author_id === user?.id));
      visible.sort((left, right) => sort === 'popular'
        ? (Number(right.like_user_ids?.length || 0) + Number(right.counts?.comments || 0)) - (Number(left.like_user_ids?.length || 0) + Number(left.counts?.comments || 0)) || String(right.created_at).localeCompare(String(left.created_at))
        : String(right.created_at).localeCompare(String(left.created_at)));
      return response({viewer: accountUser(user), posts: visible.map(blogView), stats: {posts: visible.length, media: visible.filter(post => post.media?.length).length}});
    }
    if (path === '/api/blog/posts' && method === 'POST') {
      const denied = requireUser(); if (denied) return denied;
      const title = String(body.title || '').trim();
      const content = bodyMessage(body);
      if (title.length < 4) return failure('Give your blog a title of at least four characters.');
      if (content.length < 40) return failure('Add at least 40 characters so your blog has enough context.');
      const media = await blogMediaFromForm(init);
      if (media?.error) return failure(media.error, 413);
      const post = {
        id: id('blog'), author_id: user.id, title, excerpt: String(body.excerpt || '').trim().slice(0, 280), body: content,
        tags: asList(body.tags).slice(0, 6), visibility: body.visibility === 'followers' ? 'followers' : 'public', media,
        like_user_ids: [], share_user_ids: [], counts: {likes: 0, comments: 0, shares: 0}, status: 'published', created_at: now(), updated_at: now()
      };
      store.blogs ||= []; store.blog_comments ||= [];
      store.blogs.unshift(post); persist();
      return response({message: 'Your blog is published.', post: blogView(post)});
    }
    const blogPath = path.match(/^\/api\/blog\/posts\/([^/]+)(?:\/(like|comments|share))?$/);
    if (blogPath) {
      const post = (store.blogs || []).find(item => item.id === decodeURIComponent(blogPath[1]));
      const action = blogPath[2] || '';
      if (!post) return failure('That blog could not be found.', 404);
      if (!action && method === 'GET') return response({post: blogView(post)});
      const denied = requireUser(); if (denied) return denied;
      post.like_user_ids ||= []; post.share_user_ids ||= []; store.blog_comments ||= [];
      if (action === 'like' && ['POST', 'DELETE'].includes(method)) {
        if (method === 'POST' && !post.like_user_ids.includes(user.id)) post.like_user_ids.push(user.id);
        if (method === 'DELETE') post.like_user_ids = post.like_user_ids.filter(memberId => memberId !== user.id);
        persist(); return response({post: blogView(post)});
      }
      if (action === 'share' && method === 'POST') {
        if (!post.share_user_ids.includes(user.id)) post.share_user_ids.push(user.id);
        persist(); return response({message: 'Blog link saved to your shared activity.', post: blogView(post)});
      }
      if (action === 'comments') {
        if (method === 'GET') return response({comments: store.blog_comments.filter(item => item.blog_id === post.id).sort((left, right) => String(left.created_at).localeCompare(String(right.created_at))).map(blogCommentView)});
        if (method === 'POST') {
          const commentBody = bodyMessage(body);
          if (!commentBody) return failure('Write a comment before posting.');
          if (commentBody.length > 800) return failure('Comments must be 800 characters or fewer.');
          const comment = {id: id('blog-comment'), blog_id: post.id, author_id: user.id, body: commentBody, created_at: now()};
          store.blog_comments.push(comment); post.counts ||= {}; post.counts.comments = store.blog_comments.filter(item => item.blog_id === post.id).length;
          persist(); return response({message: 'Comment added.', comment: blogCommentView(comment), post: blogView(post)});
        }
      }
      return failure('That blog action is not available.', 405);
    }
    if (path === '/api/community/posts' && method === 'POST') {
      const denied = requireUser(); if (denied) return denied;
      const uploadedMedia = await mediaFromForm(init);
      if (uploadedMedia?.error) return failure(uploadedMedia.error, 413);
      const post = {id: id('post'), author: publicUser(user), author_id: user.id, body: bodyMessage(body), visibility: body.visibility || 'public', media: uploadedMedia, counts: {likes: 0, comments: 0, shares: 0}, viewer_liked: false, viewer_shared: false, created_at: now()};
      store.posts.unshift(post); persist(); return response({message: 'Your contribution is live.', post});
    }
    if (path === '/api/community/stories' && method === 'POST') {
      const denied = requireUser(); if (denied) return denied;
      const uploadedMedia = await mediaFromForm(init);
      if (uploadedMedia?.error) return failure(uploadedMedia.error, 413);
      const story = {id: id('story'), author: publicUser(user), author_id: user.id, body: bodyMessage(body), visibility: body.visibility || 'public', media: uploadedMedia, created_at: now(), expires_at: new Date(Date.now() + 86400000).toISOString()};
      store.stories.unshift(story); persist(); return response({message: 'Your story is live for 24 hours.', story});
    }

    if (path === '/api/profile/photo') return failure('Custom profile picture uploads are no longer supported.', 404);
    if (path === '/api/profile' && method === 'PATCH') {
      const denied = requireUser(); if (denied) return denied;
      const nextProfile = {...user.profile, ...(body.profile || body)};
      // Profile photos are no longer user-configurable. Keep any legacy
      // avatar value only for display and ignore crafted update payloads.
      nextProfile.avatar_url = user.profile.avatar_url || '';
      nextProfile.display_name = String(nextProfile.display_name || '').trim() || [nextProfile.first_name, nextProfile.last_name].filter(Boolean).join(' ');
      if (user.role !== 'admin' && (!validName(nextProfile.display_name, 'display_name') || !validName(nextProfile.first_name, 'first_name') || !validName(nextProfile.last_name, 'last_name'))) return failure(nameFormatMessage);
      user.profile = nextProfile; user.preferences = {...user.preferences, ...(body.preferences || {})};
      applyAutomaticTimezone(user.profile);
      user.safety = localSafety(body.safety, user.profile, user.safety);
      if (user.safety.is_minor) user.preferences.show_location = false;
      persist(); return response({message: 'Profile saved.', user: accountUser(user)});
    }
    if (path === '/api/profile/password' && method === 'POST') {
      const denied = requireUser(); if (denied) return denied;
      user.password_hash = await hash(body.new_password || body.password || ''); persist(); return response({message: 'Password updated. Other sessions should be signed out by the production service.'});
    }
    if (path === '/api/account/privacy' && method === 'GET') { const denied = requireUser(); if (denied) return denied; return response({preferences: user.preferences || preferencesDefaults(), safety: user.safety}); }
    if (path === '/api/account/privacy' && method === 'PATCH') { const denied = requireUser(); if (denied) return denied; user.preferences = {...user.preferences, ...(body.preferences || body)}; persist(); return response({message: 'Privacy preferences saved.', preferences: user.preferences}); }
    if (path === '/api/account/privacy/cleanup' && method === 'POST') { const denied = requireUser(); if (denied) return denied; return response({message: 'A local privacy cleanup check completed. No stored media was found.'}); }
    if (path === '/api/account' && method === 'DELETE') { const denied = requireUser(); if (denied) return denied; store.users = store.users.filter(item => item.id !== user.id); delete store.streaks?.[user.id]; store.streak_days = (store.streak_days || []).filter(item => item.user_id !== user.id); store.sessionUserId = ''; persist(); return response({message: 'Your local account was removed.'}); }

    if (path === '/api/dashboard' && method === 'GET') {
      const denied = requireUser(); if (denied) return denied;
      const completeness = profileCompleteness(user);
      const conversations = store.conversations.filter(item => asList(item.member_ids).includes(user.id));
      const sessionStats = memberSessionStats(user.id);
      const ledgerEntries = (store.ledger || []).filter(item => item.user_id === user.id);
      const creditsEarned = ledgerEntries.filter(item => Number(item.amount) > 0).reduce((total, item) => total + Number(item.amount || 0), 0);
      const creditsSpent = ledgerEntries.filter(item => Number(item.amount) < 0).reduce((total, item) => total + Math.abs(Number(item.amount || 0)), 0);
      const memberEvents = store.events.filter(event => eventBelongsTo(event, user.id));
      const memberProgressReports = (store.session_progress_reports || []).filter(item => item.reporter_id === user.id);
      const completedMemberEvents = memberEvents.filter(event => event.status === 'completed' && sessionMemberIds(event).length >= 2);
      const sessionsNeedingProgressReport = completedMemberEvents.filter(event => !sessionProgressReportFor(event.id, user.id)).map(event => eventView(event, user));
      const progressJourney = memberProgressReports
        .map(report => {
          const event = store.events.find(item => item.id === report.event_id);
          if (!event) return null;
          const otherMemberId = sessionMemberIds(event).find(memberId => memberId !== user.id) || '';
          const journal = store.journals.find(item => item.source_id === report.id && item.source_type === 'session_progress_report');
          return {
            ...report,
            event_id: event.id,
            event_title: event.title || 'SwapLabs session',
            session_date: event.starts_at || report.created_at,
            minutes: Number(journal?.minutes || eventDurationHours(event) * 60 || 0),
            other_member: otherMemberId ? memberById(otherMemberId) : null,
            credit_status: event.credit_status || 'awaiting_reports'
          };
        })
        .filter(Boolean)
        .sort((first, second) => String(second.updated_at || second.created_at).localeCompare(String(first.updated_at || first.created_at)));
      const pendingSwapRequests = (store.notifications || []).filter(item => item.user_id === user.id && item.type === 'swap_request' && !item.read).length;
      const pendingGroupRequests = (store.groups || []).reduce((total, group) => {
        const moderators = asList(group.moderator_ids).length ? asList(group.moderator_ids) : asList(group.owner_id);
        return total + (moderators.includes(user.id) ? (group.pending_join_requests || []).filter(request => (request.status || 'pending') === 'pending').length : 0);
      }, 0);
      const unreadMessages = conversations.reduce((total, item) => total + conversationView(item).unread_count, 0);
      const workshopsHosted = (store.workshops || []).filter(item => item.host_id === user.id).length;
      const ideasPublished = (store.ideas || []).filter(item => item.owner_id === user.id && item.status === 'published').length;
      const nowDate = new Date();
      const weekStart = new Date(nowDate);
      weekStart.setHours(0, 0, 0, 0);
      weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7) - 77);
      const activityWeeks = Array.from({length: 12}, (_, index) => {
        const start = new Date(weekStart);
        start.setDate(start.getDate() + index * 7);
        const end = new Date(start);
        end.setDate(end.getDate() + 7);
        return {start, end, label: new Intl.DateTimeFormat('en-US', {month: 'short', day: 'numeric'}).format(start), sessions: 0, minutes: 0, reflections: 0, credits: 0};
      });
      const weekFor = value => {
        const date = new Date(value || 0);
        return Number.isNaN(date.getTime()) ? null : activityWeeks.find(week => date >= week.start && date < week.end) || null;
      };
      completedMemberEvents.forEach(event => {
        const week = weekFor(event.ends_at || event.starts_at);
        if (!week) return;
        week.sessions += 1;
        week.minutes += Math.round(eventDurationHours(event) * 60 || 0);
      });
      memberProgressReports.forEach(report => { const week = weekFor(report.updated_at || report.created_at); if (week) week.reflections += 1; });
      ledgerEntries.forEach(entry => { const week = weekFor(entry.created_at); if (week) week.credits += Number(entry.amount || 0); });
      const practicedSkills = new Map();
      progressJourney.forEach(entry => {
        const name = String(entry.event_title || 'Skill exchange').replace(/^Session reflection:\s*/i, '').trim() || 'Skill exchange';
        const current = practicedSkills.get(name) || {name, sessions: 0, minutes: 0, last_practiced_at: ''};
        current.sessions += 1;
        current.minutes += Number(entry.minutes || 0);
        if (String(entry.session_date) > String(current.last_practiced_at)) current.last_practiced_at = entry.session_date;
        practicedSkills.set(name, current);
      });
      const activityTimeline = [
        ...completedMemberEvents.map(event => ({at: event.ends_at || event.starts_at, type: 'session', icon: 'bx-calendar-check', title: `Completed ${event.title || 'a skill exchange'}`, detail: `${Math.round(eventDurationHours(event) * 60 || 0)} minutes saved`})),
        ...memberProgressReports.map(report => { const event = store.events.find(item => item.id === report.event_id); return {at: report.updated_at || report.created_at, type: 'reflection', icon: 'bx-notepad', title: `Reflected on ${event?.title || 'a session'}`, detail: report.next_step ? `Next: ${report.next_step}` : 'Progress report saved'}; }),
        ...ledgerEntries.map(entry => ({at: entry.created_at, type: 'credit', icon: Number(entry.amount || 0) >= 0 ? 'bx-plus-circle' : 'bx-minus-circle', title: `${Number(entry.amount || 0) >= 0 ? '+' : ''}${Number(entry.amount || 0)} credits`, detail: entry.description || 'Credit activity'}))
      ].filter(item => item.at).sort((first, second) => String(second.at).localeCompare(String(first.at))).slice(0, 10);
      return response({
        user: accountUser(user),
        streak: streakSummaryFor(user),
        summary: {
          credit_balance: Number(user.time_credits || 0),
          time_credits: Number(user.time_credits || 0),
          pending_requests: pendingSwapRequests + pendingGroupRequests,
          unread_messages: unreadMessages,
          completed_sessions: sessionStats.completed,
          profile_completeness: completeness,
          matches: 0,
          community_contribution: store.posts.filter(item => item.author_id === user.id).length
        },
        metrics: metrics(),
        analytics: {
          completed_session_hours: sessionStats.completedHours,
          credits_earned: creditsEarned,
          credits_spent: creditsSpent,
          conversations: conversations.length,
          messages_sent: store.messages.filter(item => item.sender_id === user.id).length,
          profile_completeness: completeness,
          sessions: {completed: sessionStats.completed, scheduled: sessionStats.scheduled, cancelled: sessionStats.cancelled},
          progress_reports: memberProgressReports.length,
          sessions_needing_progress_report: sessionsNeedingProgressReport.length,
          workshops_hosted: workshopsHosted,
          ideas_published: ideasPublished
        },
        suggested_action: completeness < 100 ? {icon: 'bx-user-check', title: 'Finish your profile', description: 'Complete every essential profile field before you start matching or making member connections.', href: 'profile.html'} : {icon: 'bx-compass', title: 'Find a skill to exchange', description: 'Browse the public directory and choose a useful first step.', href: 'browse-skills.html'},
        learning_goal: {title: user.profile.learning_goal || 'Add your first learning goal', completed_sessions: sessionStats.completed, profile_completeness: completeness},
        recommended_matches: [],
        upcoming_sessions: store.events.filter(event => event.status === 'scheduled' && eventBelongsTo(event, user.id)).map(event => eventView(event)),
        sessions_needing_progress_report: sessionsNeedingProgressReport,
        progress_journey: progressJourney.slice(0, 12),
        journey_analytics: {
          weeks: activityWeeks.map(({start, end, ...week}) => week),
          skills: [...practicedSkills.values()].sort((first, second) => second.minutes - first.minutes).slice(0, 6),
          timeline: activityTimeline,
          outcomes: {
            completion_rate: sessionStats.completed + sessionStats.cancelled ? Math.round((sessionStats.completed / (sessionStats.completed + sessionStats.cancelled)) * 100) : 0,
            reflection_rate: completedMemberEvents.length ? Math.round((memberProgressReports.length / completedMemberEvents.length) * 100) : 0,
            completed: sessionStats.completed,
            scheduled: sessionStats.scheduled,
            reports_due: sessionsNeedingProgressReport.length
          },
          credits: {balance: Number(user.time_credits || 0), earned: creditsEarned, spent: creditsSpent, recent: ledgerEntries.slice().sort((first, second) => String(second.created_at).localeCompare(String(first.created_at))).slice(0, 5)}
        },
        recent_messages: conversations.map(conversationView).slice(0, 6),
        onboarding_complete: Boolean(store.onboarding[user.id]) && completeness >= 100
      });
    }
    if (path === '/api/streak' && method === 'GET') { const denied = requireUser(); if (denied) return denied; return response({streak: streakSummaryFor(user)}); }
    if (path === '/api/dashboard/onboarding' && method === 'POST') { const denied = requireUser(); if (denied) return denied; store.onboarding[user.id] = true; persist(); return response({message: 'Walkthrough saved.'}); }
    if (path === '/api/achievements' && method === 'GET') {
      const denied = requireUser(); if (denied) return denied;
      const pinned = store.achievements[user.id] || [];
      const badges = [
        {id: 'profile-starter', icon: 'bx-user-check', title: 'Profile starter', description: 'Add the context that helps useful introductions happen.', current: profileCompleteness(user), target: 100},
        {id: 'curious-teacher', icon: 'bx-bulb', title: 'Curious teacher', description: 'List a skill you can share with the community.', current: asList(user.profile.skills_to_teach).length ? 1 : 0, target: 1},
        {id: 'learning-direction', icon: 'bx-compass', title: 'Learning direction', description: 'Name a skill or goal you want to explore next.', current: asList(user.profile.skills_to_learn).length || user.profile.learning_goal ? 1 : 0, target: 1},
        {id: 'reflection-keeper', icon: 'bx-notepad', title: 'Reflection keeper', description: 'Save a reflection after an exchange.', current: store.journals.filter(item => item.user_id === user.id).length, target: 1}
      ].map(item => ({...item, progress: Math.min(100, Math.round(Number(item.current || 0) / Math.max(1, Number(item.target || 1)) * 100)), earned: Number(item.current || 0) >= Number(item.target || 1), pinned: pinned.includes(item.id)}));
      return response({badges, stats: {earned: badges.filter(item => item.earned).length, total: badges.length, pinned: pinned.length}});
    }
    if (path === '/api/achievements/pins' && method === 'PATCH') {
      const denied = requireUser(); if (denied) return denied;
      store.achievements[user.id] = asList(body.achievement_ids).slice(0, 4); persist();
      const badges = (await route('/api/achievements')).badges;
      return response({badges});
    }
    if (path === '/api/matches' && method === 'POST') {
      const denied = requireUser(); if (denied) return denied;
      const learn = new Set(asList(body.learn_skills)); const teach = new Set(asList(body.teach_skills));
      const strictSkillMatch = Object.prototype.hasOwnProperty.call(body, 'strict_skill_match')
        ? !(body.strict_skill_match === false || body.strict_skill_match === 'false')
        : false;
      const useDemographicPreferences = body.use_demographic_preferences === true || body.use_demographic_preferences === 'true';
      const viewerAge = ageFromDateOfBirth(user.profile?.date_of_birth) ?? Number(user.profile?.age);
      const viewerGender = String(user.profile?.gender || '').trim().toLowerCase();
      const viewerLanguages = asList([user.profile?.primary_language, user.profile?.additional_languages, user.profile?.languages_to_learn]);
      const experienceScore = (viewerLevel, candidateLevel) => {
        const levels = ['beginner', 'intermediate', 'advanced', 'expert'];
        const first = skillKey(viewerLevel); const second = skillKey(candidateLevel);
        const firstIndex = levels.findIndex(level => first.includes(level));
        const secondIndex = levels.findIndex(level => second.includes(level));
        if (firstIndex < 0 || secondIndex < 0) return 0;
        const distance = Math.abs(firstIndex - secondIndex);
        return distance === 0 ? 5 : distance === 1 ? 3 : 1;
      };
      const completedFor = memberId => (store.events || []).filter(event => ['completed', 'ended', 'closed'].includes(String(event.status || '').toLowerCase()) && (event.host_id === memberId || asList(event.participant_ids).includes(memberId))).length;
      const availabilityFor = candidate => {
        const viewerText = skillKey(user.profile?.availability);
        const candidateText = skillKey(candidate.profile?.availability);
        const viewerTimezone = skillKey(user.profile?.timezone);
        const candidateTimezone = skillKey(candidate.profile?.timezone);
        const windows = ['morning', 'afternoon', 'evening', 'night', 'weekday', 'weekend'];
        const sharedWindow = windows.some(window => viewerText.includes(window) && candidateText.includes(window));
        const flexible = value => /flexible|anytime|open|varies|most days|most times|weekdays|weekends/.test(value);
        let points = viewerTimezone && candidateTimezone && viewerTimezone === candidateTimezone ? 3 : 0;
        if (viewerText && candidateText && (flexible(viewerText) || flexible(candidateText) || sharedWindow)) points += 5;
        else if (viewerText && candidateText) points += 2;
        return {points: Math.min(8, points), sameTimezone: Boolean(viewerTimezone && candidateTimezone && viewerTimezone === candidateTimezone), sharedWindow: Boolean(sharedWindow), label: candidate.profile?.availability || (candidate.profile?.timezone ? `Availability in ${candidate.profile.timezone}` : 'Availability to confirm')};
      };
      const ageBands = ['child', 'teen', '18-24', '25-34', '35-44', '45-plus'];
      const ageBand = age => {
        const value = Number(age);
        if (!Number.isFinite(value) || value < 0) return '';
        if (value < 13) return 'child';
        if (value < 18) return 'teen';
        if (value < 25) return '18-24';
        if (value < 35) return '25-34';
        if (value < 45) return '35-44';
        return '45-plus';
      };
      const matches = store.users.filter(item => item.id !== user.id && item.status === 'active').map(candidate => {
        const candidateTeach = asList(candidate.profile?.skills_to_teach);
        const candidateLearn = asList(candidate.profile?.skills_to_learn);
        const learningFit = skillOverlap([...learn], candidateTeach);
        const teachingFit = skillOverlap([...teach], candidateLearn);
        const direct = learningFit.direct;
        const related = learningFit.related;
        const bestLearningFit = learningFit.best;
        const reciprocal = teachingFit.best;
        const candidateLanguages = asList([candidate.profile?.primary_language, candidate.profile?.additional_languages]);
        const sharedLanguage = viewerLanguages.some(language => candidateLanguages.some(candidateLanguage => skillTokenFit(language, candidateLanguage)));
        const contextFit = skillOverlap(
          [body.learning_goal, body.interests, user.profile?.learning_goal, user.profile?.interests],
          [candidate.profile?.learning_goal, candidate.profile?.interests, ...candidateTeach, ...candidateLearn]
        ).best;
        const availability = availabilityFor(candidate);
        const completedSessions = completedFor(candidate.id);
        const reliabilityPoints = Math.min(6, completedSessions * 2);
        const directPoints = direct.length ? Math.min(58, 46 + Math.max(0, direct.length - 1) * 6) : 0;
        const relatedPoints = !direct.length && related.length ? Math.min(42, 30 + Math.max(0, related.length - 1) * 5) : 0;
        const discoveryPoints = !direct.length && !related.length ? (strictSkillMatch ? 0 : 12) : 0;
        const reciprocalPoints = reciprocal ? (direct.length ? reciprocal.kind === 'related' ? 8 : 14 : 10) : 0;
        const languagePoints = sharedLanguage ? 8 : 0;
        const goalPoints = contextFit ? 7 : 0;
        const levelPoints = experienceScore(body.proficiency || user.profile?.experience_level, candidate.profile?.experience_level);
        const style = String(body.teaching_style || '').toLowerCase();
        const candidateStyle = String(candidate.profile?.teaching_style || '').toLowerCase();
        const stylePoints = style && candidateStyle && (style === candidateStyle || style.includes('flexible') || candidateStyle.includes('flexible')) ? 5 : 0;
        const requestedFormat = String(body.session_format || '').toLowerCase();
        const candidateFormat = String(candidate.profile?.preferred_format || '').toLowerCase();
        const formatPoints = requestedFormat && candidateFormat && (requestedFormat === candidateFormat || requestedFormat.includes('flexible') || candidateFormat.includes('flexible') || requestedFormat.includes('remote') && candidateFormat.includes('remote') || requestedFormat.includes('local') && candidateFormat.includes('local')) ? 5 : 0;
        const demographicReasons = [];
        let demographicPoints = 0;
        const candidateGender = String(candidate.profile?.gender || '').trim().toLowerCase();
        const sameGender = Boolean(useDemographicPreferences && viewerGender && candidateGender && viewerGender === candidateGender);
        let candidateAgePoints = 0;
        let candidateGenderPoints = 0;
        if (useDemographicPreferences) {
          const viewerBand = ageBand(viewerAge);
          const candidateAge = ageFromDateOfBirth(candidate.profile?.date_of_birth) ?? Number(candidate.profile?.age);
          const candidateBand = ageBand(candidateAge);
          const ageDistance = viewerBand && candidateBand ? Math.abs(ageBands.indexOf(viewerBand) - ageBands.indexOf(candidateBand)) : null;
          candidateAgePoints = ageDistance === 0 ? 8 : ageDistance === 1 ? 4 : 0;
          candidateGenderPoints = sameGender ? 4 : 0;
          demographicPoints = candidateAgePoints + candidateGenderPoints;
          demographicReasons.push({label: 'Optional age proximity', points: candidateAgePoints, max_points: 8, explanation: candidateAgePoints === 8 ? 'Both profiles are in the same broad age band.' : candidateAgePoints ? 'The profiles are in adjacent broad age bands.' : 'Age proximity did not add points.'});
          demographicReasons.push({label: 'Optional gender preference', points: candidateGenderPoints, max_points: 4, explanation: sameGender ? 'Both members explicitly opted into the same gender preference.' : 'No optional gender preference boost was applied.'});
        }
        const profilePoints = (candidate.profile?.headline ? 2 : 0) + (candidate.profile?.bio ? 2 : 0) + (candidateTeach.length ? 2 : 0) + (candidate.profile?.availability ? 1 : 0);
        const score = Math.min(100, directPoints + relatedPoints + discoveryPoints + reciprocalPoints + languagePoints + goalPoints + levelPoints + availability.points + stylePoints + formatPoints + reliabilityPoints + profilePoints + demographicPoints);
        if (strictSkillMatch && !bestLearningFit) return null;
        const reasons = [
          direct.length
            ? {label: 'Direct teaching fit', points: directPoints, max_points: 58, explanation: `${direct[0].found} is listed as a skill this member can teach.`}
            : related.length
              ? {label: 'Related skill group', points: relatedPoints, max_points: 42, explanation: `${related[0].found} is in the ${related[0].family} group and is closely related to ${related[0].requested}.`}
              : {label: 'Broader discovery', points: discoveryPoints, max_points: 12, explanation: 'This member is surfaced using goals, language, timing, profile context, and exchange history.'},
          {label: 'Two-way potential', points: reciprocalPoints, max_points: 14, explanation: reciprocal ? `They also want to learn ${reciprocal.found}, which you can teach.` : 'A reciprocal offer is optional; a one-way learning fit is enough.'},
          {label: 'Learning goal and interests', points: goalPoints, max_points: 7, explanation: contextFit ? `Your goals or interests overlap around ${contextFit.found}.` : 'No goal or interest overlap was found.'},
          {label: 'Shared language', points: languagePoints, max_points: 8, explanation: sharedLanguage ? 'You share a listed language for the conversation.' : 'No shared language boost was applied.'},
          {label: 'Availability and timezone', points: availability.points, max_points: 8, explanation: availability.sameTimezone && availability.sharedWindow ? 'The listed timing looks compatible.' : availability.sameTimezone ? 'The listed timezones match; confirm a window in chat.' : availability.sharedWindow ? 'The listed windows overlap; confirm the timezone in chat.' : 'Availability can be confirmed before scheduling.'},
          {label: 'Experience level', points: levelPoints, max_points: 5, explanation: levelPoints ? 'The experience levels are compatible.' : 'Experience level did not change the order.'},
          {label: 'Teaching style', points: stylePoints, max_points: 5, explanation: stylePoints ? 'Their teaching style matches your preference.' : 'Teaching style can be agreed in chat.'},
          {label: 'Session format', points: formatPoints, max_points: 5, explanation: formatPoints ? 'Their preferred format fits your selection.' : 'Session format can be agreed in chat.'},
          {label: 'Completed exchanges', points: reliabilityPoints, max_points: 6, explanation: completedSessions ? `${completedSessions} completed exchange${completedSessions === 1 ? '' : 's'} add a small reliability boost.` : 'No completed exchange history yet; new members remain eligible.'},
          {label: 'Profile context', points: profilePoints, max_points: 7, explanation: profilePoints >= 5 ? 'This member has enough context to make the introduction practical.' : 'A lighter profile means more can be confirmed in chat.'},
          ...demographicReasons
        ];
        const topReasons = direct.length
          ? [`Teaches ${direct[0].found}, your requested learning skill.`]
          : related.length
            ? [`Teaches ${related[0].found}, a related skill in the ${related[0].family} family.`]
            : ['Broader discovery result: goals, language, timing, and profile context still make this member worth considering.'];
        if (reciprocal) topReasons.push('Can also learn from you, so no credits transfer at the end.');
        else if (bestLearningFit) topReasons.push('One-way exchange: 1 credit transfers from the learner to the teacher after both reports are complete.');
        if (contextFit && !bestLearningFit) topReasons.push(`Your goals or interests overlap around ${contextFit.found}.`);
        if (availability.points >= 5) topReasons.push('The listed timing looks practical for a first session.');
        if (completedSessions) topReasons.push(`${completedSessions} completed exchange${completedSessions === 1 ? '' : 's'} recorded.`);
        if (sameGender) topReasons.push('Optional gender preference was used because you enabled it.');
        const skillGroup = bestLearningFit?.family || skillFamily(bestLearningFit?.found) || '';
        const exchangeType = bestLearningFit ? (reciprocal ? 'mutual' : 'one_way') : reciprocal ? 'reverse_one_way' : 'discovery';
        const publicCandidate = publicUser(candidate);
        return {id: id('match'), skill_group: skillGroup, candidate: {...publicCandidate, skill_group: skillGroup, skill_categories: skillGroup ? [skillGroup] : []}, score, match_quality: direct.length ? (score >= 72 ? 'strong' : 'good') : related.length ? 'related' : 'discovery', exchange_type: exchangeType, exchange_credit_rule: exchangeType === 'mutual' ? 'No credit transfer when both members teach and learn from each other.' : exchangeType === 'one_way' ? '1 credit transfers from the learner to the teacher after the exchange.' : 'Confirm the exchange direction with the member before scheduling.', request_skill: bestLearningFit?.requested || candidateTeach[0] || 'a useful skill', request_offer: teachingFit.best?.requested || [...teach][0] || '', top_reasons: topReasons, reasons, availability: {label: availability.label, available_now: false, next_overlap_at: null, same_timezone: availability.sameTimezone, shared_window: availability.sharedWindow}};
      }).filter(match => match && (match.score > 0 || !strictSkillMatch));
      return response({matches, empty_state: matches.length ? null : {message: strictSkillMatch ? 'No direct or related fit was found yet. Turn off exact-fit prioritisation to see broader discovery members.' : 'No active members are available for discovery yet. Ask members to turn on matching in their profile settings.'}, query: {strict_skill_match: strictSkillMatch, use_demographic_preferences: useDemographicPreferences, grouped_skill_families: [...new Set([...learn, ...teach].map(skillFamily).filter(Boolean))]}});
    }
    if (path === '/api/swaps' && method === 'POST') {
      const denied = requireUser(); if (denied) return denied;
      const target = findUser(body.target_user_id); if (!target) return failure('That member is no longer available.', 404);
      const conversation = directConversationFor(target);
      if (!conversation) return failure('Choose another active member.', 400);
      const message = {id: id('msg'), conversation_id: conversation.id, sender_id: user.id, body: `Exchange request: ${body.skill || 'a useful skill'}${body.offer ? ` in return for ${body.offer}` : ''}.`, read: false, created_at: now()};
      store.messages.push(message); conversation.updated_at = message.created_at; notification(target.id, 'swap_request', `${user.profile.display_name} sent an exchange request.`, conversation.id); persist();
      return response({message: 'Exchange request sent.', conversation: conversationView(conversation)});
    }

    if (path === '/api/inbox/contacts' && method === 'GET') {
      const denied = requireUser(); if (denied) return denied;
      return response({contacts: store.users.filter(item => item.id !== user.id && item.role === 'member' && item.status === 'active').map(publicUser)});
    }
    if (path === '/api/inbox' && method === 'GET') {
      const denied = requireUser(); if (denied) return denied;
      const conversations = store.conversations.filter(item => asList(item.member_ids).includes(user.id) && !asList(item.hidden_for).includes(user.id)).map(conversationView);
      return response({conversations, contacts: store.users.filter(item => item.id !== user.id && item.status === 'active').map(publicUser), incoming_requests: [], follow_requests: [], unread_count: conversations.reduce((total, item) => total + Number(item.unread_count || 0), 0)});
    }
    const leaveGroupMatch = path.match(/^\/api\/inbox\/groups\/([^/]+)\/members\/me$/);
    if (leaveGroupMatch && method === 'DELETE') {
      const denied = requireUser(); if (denied) return denied;
      const conversationId = decodeURIComponent(leaveGroupMatch[1]);
      const conversation = store.conversations.find(item => item.id === conversationId);
      const group = store.groups.find(item => item.conversation_id === conversationId);
      if (!conversation || conversation.kind !== 'group') return failure('Group chat not found.', 404);
      if (!asList(conversation.member_ids).includes(user.id)) return failure('You are no longer a member of this chat.', 400);
      if (group?.owner_id === user.id) return failure('The group creator cannot leave this chat.', 400);
      conversation.member_ids = asList(conversation.member_ids).filter(idValue => idValue !== user.id);
      conversation.hidden_for = [...new Set([...asList(conversation.hidden_for), user.id])];
      if (group) {
        group.member_ids = asList(group.member_ids).filter(idValue => idValue !== user.id);
        group.pending_join_requests = (group.pending_join_requests || []).filter(request => request.user_id !== user.id);
        group.updated_at = now();
      }
      conversation.updated_at = now();
      persist();
      return response({message: 'You left the group.', conversation_id: conversationId});
    }
    const conversationMatch = path.match(/^\/api\/inbox\/conversations\/([^/]+)(?:\/(.*))?$/);
    if (conversationMatch) {
      const denied = requireUser(); if (denied) return denied;
      const conversation = store.conversations.find(item => item.id === decodeURIComponent(conversationMatch[1])); if (!conversation) return failure('Conversation not found.', 404);
      const action = conversationMatch[2] || '';
      const hiddenForViewer = asList(conversation.hidden_for).includes(user.id);
      if (!asList(conversation.member_ids).includes(user.id) || (hiddenForViewer && action !== 'messages')) return failure('Conversation not found.', 404);
      if (!action && method === 'DELETE') {
        conversation.hidden_for = [...new Set([...asList(conversation.hidden_for), user.id])];
        hideConversationHistoryFor(conversation);
        persist();
        return response({message: 'Chat deleted from your Inbox.', conversation_id: conversation.id});
      }
      if (!action && method === 'GET') {
        // Opening the conversation is the read action in local mode too. Keep
        // the browser mirror and the hosted API on the same contract.
        store.messages.filter(item => item.conversation_id === conversation.id && item.sender_id !== user.id && !asList(item.hidden_for).includes(user.id)).forEach(item => { item.read = true; });
        persist();
        return response({conversation: conversationView(conversation), messages: conversationMessages(conversation).map(item => ({...item, sender: memberById(item.sender_id)})), shared_content: {posts: [], ideas: [], workshops: []}});
      }
      if (action === 'messages' && method === 'POST') {
        conversation.hidden_for = asList(conversation.hidden_for).filter(idValue => idValue !== user.id);
        const message = {id: id('msg'), conversation_id: conversation.id, sender_id: user.id, body: bodyMessage(body), read: false, created_at: now()};
        store.messages.push(message); conversation.updated_at = now(); persist();
        return response({message: {...message, sender: memberById(user.id)}});
      }
      if (action === 'read' && method === 'POST') {
        store.messages.filter(item => item.conversation_id === conversation.id && item.sender_id !== user.id && !asList(item.hidden_for).includes(user.id)).forEach(item => { item.read = true; });
        persist();
        return response({ok: true, conversation_id: conversation.id, unread_count: 0});
      }
      if (action === 'mute' && method === 'POST') {
        setConversationUserFlag(conversation, 'muted_for', body.muted !== false);
        persist();
        return response({ok: true, conversation: conversationView(conversation)});
      }
      if (action === 'block' && method === 'POST') {
        setConversationUserFlag(conversation, 'blocked_for', body.blocked !== false);
        persist();
        return response({ok: true, conversation: conversationView(conversation)});
      }
      if (action === 'typing' || action === 'content') return response({ok: true, conversation: conversationView(conversation), messages: conversationMessages(conversation)});
      if (action === 'history' && method === 'DELETE') {
        hideConversationHistoryFor(conversation);
        persist();
        return response({message: 'Conversation history cleared for you.', conversation_id: conversation.id});
      }
      return response({ok: true, conversation: conversationView(conversation)});
    }
    if (path === '/api/inbox/conversations' && method === 'POST') {
      const denied = requireUser(); if (denied) return denied;
      const target = findUser(body.target_user_id); if (!target) return failure('Choose a member to message.', 400);
      const conversation = directConversationFor(target);
      if (!conversation) return failure('Choose another active member.', 400);
      persist();
      return response({conversation: conversationView(conversation)});
    }
    if (path === '/api/notifications' && method === 'GET') { const denied = requireUser(); if (denied) return denied; const notes = store.notifications.filter(item => item.user_id === user.id); return response({notifications: notes, inbox_unread_count: store.conversations.filter(item => asList(item.member_ids).includes(user.id) && !asList(item.hidden_for).includes(user.id)).reduce((n, item) => n + conversationView(item).unread_count, 0), notification_unread_count: notes.filter(item => !item.read).length, pending_count: 0, unread_count: notes.filter(item => !item.read).length, follow_requests: []}); }
    if (path === '/api/notifications/read-all' && method === 'POST') { const denied = requireUser(); if (denied) return denied; store.notifications.filter(item => item.user_id === user.id).forEach(item => { item.read = true; }); persist(); return response({message: 'Notifications marked as read.'}); }
    if (/^\/api\/notifications\/[^/]+\/read$/.test(path) && ['POST', 'PATCH'].includes(method)) { const denied = requireUser(); if (denied) return denied; const note = store.notifications.find(item => item.id === decodeURIComponent(path.split('/')[3]) && item.user_id === user.id); if (note) note.read = true; persist(); return response({message: 'Notification marked as read.'}); }

    if (path === '/api/calendar' && method === 'GET') {
      const denied = requireUser(); if (denied) return denied;
      const memberEvents = store.events.filter(item => item.host_id === user.id || item.participant_ids?.includes(user.id));
      const linkedConversationsChanged = memberEvents.some(event => ensureSessionConversation(event));
      if (linkedConversationsChanged) persist();
      return response({
        events: memberEvents.map(event => eventView(event)),
        contacts: calendarContactUsers(user.id),
        contact_scope: 'followers_or_following',
        availability: {timezone: user.profile.timezone || 'UTC', buffer_minutes: 15, weekly: {}}
      });
    }
    const sessionRatingPath = path.match(/^\/api\/calendar\/events\/([^/]+)\/rating$/);
    if (sessionRatingPath && ['GET', 'POST'].includes(method)) {
      const denied = requireUser(); if (denied) return denied;
      const event = store.events.find(item => item.id === decodeURIComponent(sessionRatingPath[1]));
      if (!event) return failure('Session not found.', 404);
      if (!eventBelongsTo(event, user.id)) return failure('Only session members can view or submit this rating.', 403);
      if (method === 'GET') return response({summary: sessionRatingSummary(event, user)});
      if (sessionMemberIds(event).length < 2) return failure('This calendar item does not have another session member to rate.', 400);
      if (event.status !== 'completed') return failure('Confirm the session before rating it.', 400);
      const ratingValue = Number(body.rating);
      if (!Number.isInteger(ratingValue) || ratingValue < 1 || ratingValue > 5) return failure('Choose a rating from 1 to 5.', 400);
      if (sessionRatingsFor(event.id).some(item => item.rater_id === user.id)) return failure('You have already rated this session.', 409);
      const comment = String(body.comment || '').trim().slice(0, 1200);
      const rating = {id: id('session-rating'), event_id: event.id, rater_id: user.id, rating: ratingValue, comment, created_at: now(), points_awarded: 0, points_status: 'pending'};
      store.session_ratings.push(rating);
      const review = ensureSessionPointReview(event);
      if (review?.status === 'pending') {
        rating.points_status = 'held_for_review';
      } else if (review?.status === 'denied') {
        revokeSessionPoints(rating);
        event.points_status = 'withheld';
      } else {
        awardSessionPoints(rating);
        event.points_status = 'awarded';
      }
      persist();
      const underReview = review?.status === 'pending';
      const pointsWithheld = rating.points_status === 'withheld';
      return response({
        message: underReview ? 'Rating saved. The session is under administrator review before points are finalized.' : pointsWithheld ? 'Rating saved. Points for this session were withheld by the administrator.' : `Rating saved. ${SESSION_RATING_POINTS} private points were awarded.`,
        rating: {id: rating.id, rating: rating.rating, comment: rating.comment, points_status: rating.points_status, points_awarded: Number(rating.points_awarded || 0)},
        summary: sessionRatingSummary(event, user)
      });
    }
    const sessionProgressPath = path.match(/^\/api\/calendar\/events\/([^/]+)\/progress-report$/);
    if (sessionProgressPath && ['GET', 'POST'].includes(method)) {
      const denied = requireUser(); if (denied) return denied;
      const event = store.events.find(item => item.id === decodeURIComponent(sessionProgressPath[1]));
      if (!event) return failure('Session not found.', 404);
      const isAdmin = user.role === 'admin';
      if (!isAdmin && !eventBelongsTo(event, user.id)) return failure('Only session members can view or submit this progress report.', 403);
      ensureSessionCreditMetadata(event);
      if (method === 'GET') {
        const reports = sessionProgressReportsFor(event.id);
        return response({
          report: isAdmin ? null : sessionProgressReportFor(event.id, user.id),
          reports: isAdmin ? reports : undefined,
          summary: sessionProgressSummary(event, user)
        });
      }
      if (event.status !== 'completed') return failure('Confirm the session before submitting its progress report.', 400);
      if (sessionMemberIds(event).length < 2) return failure('This session needs two members before progress can be recorded.', 400);
      const whatHappened = String(body.what_happened || body.summary || '').trim().slice(0, 4000);
      const progress = String(body.progress || body.outcome || '').trim().slice(0, 2400);
      const nextStep = String(body.next_step || '').trim().slice(0, 1200);
      const overallRating = Number(body.overall_rating ?? body.rating);
      if (whatHappened.length < 5) return failure('Describe what happened during the exchange before saving the report.');
      if (progress.length < 5) return failure('Describe what progress was made before saving the report.');
      if (!Number.isInteger(overallRating) || overallRating < 1 || overallRating > 5) return failure('Choose an overall session rating from 1 to 5.');
      const reporterId = isAdmin ? String(body.reporter_id || '') : user.id;
      if (!reporterId || !sessionMemberIds(event).includes(reporterId)) return failure('Choose the session member whose report is being saved.', 400);
      let report = sessionProgressReportFor(event.id, reporterId);
      const timestamp = now();
      if (!report) {
        report = {id: id('session-progress'), event_id: event.id, reporter_id: reporterId, what_happened: whatHappened, progress, overall_rating: overallRating, next_step: nextStep, created_at: timestamp, updated_at: timestamp};
        store.session_progress_reports.push(report);
      } else {
        Object.assign(report, {what_happened: whatHappened, progress, overall_rating: overallRating, next_step: nextStep, updated_at: timestamp});
      }
      store.journals ||= [];
      const journalBody = `What happened: ${whatHappened}\n\nProgress: ${progress}`;
      const journal = store.journals.find(item => item.user_id === reporterId && item.source_type === 'session_progress_report' && item.source_id === report.id);
      const journalData = {user_id: reporterId, title: `Session reflection: ${event.title || 'SwapLabs session'}`, skill: event.title || 'Skill exchange', minutes: Math.round(eventDurationHours(event) * 60), confidence: overallRating, mood: overallRating >= 4 ? 'energized' : overallRating >= 3 ? 'curious' : 'needs support', visibility: 'private', reflection: journalBody, next_step: nextStep, source_type: 'session_progress_report', source_id: report.id, event_id: event.id, created_at: journal?.created_at || timestamp, updated_at: timestamp};
      if (journal) Object.assign(journal, journalData);
      else store.journals.unshift({id: id('journal'), ...journalData});
      const settlement = settleSessionCredits(event);
      sessionMemberIds(event).filter(memberId => memberId !== reporterId).forEach(memberId => notification(memberId, 'session_progress_report', `${findUser(reporterId)?.profile?.display_name || 'A session member'} saved a progress report for “${event.title || 'your session'}”.`, event.id));
      await persist();
      const summary = sessionProgressSummary(event, user);
      return response({
        message: settlement.status === 'settled' ? 'Progress report saved. Both reports are complete and the session credits were settled.' : 'Progress report saved. The other participant still needs to submit their report.',
        report: {...report},
        summary,
        settlement
      });
    }
    const eventPath = path.match(/^\/api\/calendar\/events(?:\/([^/]+))?(?:\/(ics))?$/);
    if (eventPath) {
      const denied = requireUser(); if (denied) return denied;
      if (eventPath[2] === 'ics') { const event = store.events.find(item => item.id === decodeURIComponent(eventPath[1])); return textResponse(`BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nSUMMARY:${event?.title || 'SwapLabs session'}\nDTSTART:${event ? event.starts_at.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') : ''}\nEND:VEVENT\nEND:VCALENDAR`, 'text/calendar; charset=utf-8'); }
      if (!eventPath[1] && method === 'POST') {
        const allowedContactIds = new Set(calendarContactUsers(user.id).map(member => member.id));
        const participantIds = [...new Set(asList(body.participant_ids))];
        if (participantIds.some(memberId => !allowedContactIds.has(memberId))) return failure('Invite only people you follow or who follow you.', 400);
        const starts = body.starts_at || new Date(Date.now() + 86400000).toISOString();
        const event = {id: id('event'), title: body.title || 'SwapLabs session', description: body.description || '', starts_at: starts, ends_at: body.ends_at || new Date(new Date(starts).getTime() + 3600000).toISOString(), timezone: body.timezone || user.profile.timezone || 'UTC', host_id: user.id, participant_ids: participantIds, conversation_id: body.conversation_id || '', status: 'scheduled', location: body.location || '', meeting_url: body.meeting_url || '', reminders_minutes: body.reminders_minutes || [60], all_day: Boolean(body.all_day), points_status: 'awaiting_ratings', session_cost_credits: EXCHANGE_CREDIT_AMOUNT, one_way_reward_credits: EXCHANGE_CREDIT_AMOUNT, credit_payer_id: user.id, credit_status: 'not_started', credit_reward_recipients: [], credit_transfer_type: '', credit_transfer_amount: 0, credit_transfer_payer_id: '', credit_transfer_recipient_id: '', credit_transfer_skill: ''};
        ensureSessionConversation(event);
        store.events.push(event); persist(); return response({event: eventView(event), message: 'Session scheduled.'});
      }
      const event = store.events.find(item => item.id === decodeURIComponent(eventPath[1])); if (!event) return failure('Session not found.', 404);
      if (method === 'GET') {
        if (ensureSessionConversation(event)) persist();
        return response({event: eventView(event)});
      }
      if (method === 'PATCH') {
        if (user.role !== 'admin' && !eventBelongsTo(event, user.id)) return failure('Only session members can update this session.', 403);
        if (user.role !== 'admin' && Object.keys(body).some(field => !['status'].includes(field)) && event.host_id !== user.id) return failure('Only the session host can edit session details.', 403);
        if (Object.prototype.hasOwnProperty.call(body, 'participant_ids')) {
          if (user.role !== 'admin' && event.host_id !== user.id) return failure('Only the session host can change invitees.', 403);
          const allowedContactIds = new Set(calendarContactUsers(user.id).map(member => member.id));
          const participantIds = [...new Set(asList(body.participant_ids))];
          if (user.role !== 'admin' && participantIds.some(memberId => !allowedContactIds.has(memberId))) return failure('Invite only people you follow or who follow you.', 400);
          body.participant_ids = participantIds;
        }
        const wasCompleted = event.status === 'completed';
        if (body.status === 'completed') {
          const endsAt = new Date(event.ends_at || '').getTime();
          if (user.role !== 'admin' && (!Number.isFinite(endsAt) || endsAt > Date.now())) return failure('You can confirm completion after the scheduled end time.', 400);
          event.completed_at = now();
          event.completed_by = user.id;
        }
        ['session_cost_credits', 'one_way_reward_credits', 'credit_payer_id', 'credit_status', 'credit_settlement_id', 'credit_settlement_at', 'credit_reward_recipients', 'credit_transfer_type', 'credit_transfer_amount', 'credit_transfer_payer_id', 'credit_transfer_recipient_id', 'credit_transfer_skill'].forEach(field => { delete body[field]; });
        Object.assign(event, body);
        ensureSessionCreditMetadata(event);
        if (event.status === 'completed') settleSessionCredits(event);
        if (!wasCompleted && event.status === 'completed') sessionMemberIds(event).forEach(memberId => recordLearningSessionCompletion(memberId, event.id));
        ensureSessionConversation(event);
        persist(); return response({event: eventView(event), message: 'Session updated.'});
      }
      if (method === 'DELETE') {
        if (user.role !== 'admin' && event.host_id !== user.id) return failure('Only the session host can cancel this session.', 403);
        event.status = 'cancelled'; persist(); return response({message: 'Session cancelled.', event: eventView(event)});
      }
    }

    if (path === '/api/credits' && method === 'GET') {
      const denied = requireUser(); if (denied) return denied;
      const entries = store.ledger.filter(item => item.user_id === user.id);
      return response({
        balance: Number(user.time_credits || 0),
        entries,
        contacts: store.users.filter(item => item.id !== user.id && item.status === 'active').map(publicUser),
        disputes: store.disputes.filter(item => item.user_id === user.id),
        stats: {
          earned: entries.filter(item => Number(item.amount) > 0).reduce((sum, item) => sum + Number(item.amount), 0),
          spent: Math.abs(entries.filter(item => Number(item.amount) < 0).reduce((sum, item) => sum + Number(item.amount), 0)),
          open_disputes: store.disputes.filter(item => item.user_id === user.id && ['open', 'reviewing'].includes(item.status)).length
        }
      });
    }
    if (path === '/api/credits/transfer' && method === 'POST') {
      const denied = requireUser(); if (denied) return denied;
      const recipient = findUser(body.recipient_id);
      const amount = Math.floor(Number(body.amount || 0));
      if (!recipient || recipient.id === user.id) return failure('Choose another member to receive the credits.');
      if (!Number.isFinite(amount) || amount < 1) return failure('Enter a positive whole number of credits.');
      if (amount > Number(user.time_credits || 0)) return failure('You do not have enough time credits.');
      user.time_credits -= amount; recipient.time_credits = Number(recipient.time_credits || 0) + amount;
      const reference = id('payment');
      store.ledger.push({id: id('ledger'), user_id: user.id, type: 'payment', amount: -amount, balance_after: user.time_credits, description: body.description || `Payment to ${recipient.profile.display_name || recipient.username}`, counterparty: publicUser(recipient), reference_id: reference, reference_type: 'credit_transfer', created_by: user.id, created_at: now()});
      store.ledger.push({id: id('ledger'), user_id: recipient.id, type: 'payment', amount, balance_after: recipient.time_credits, description: `Payment from ${user.profile.display_name || user.username}`, counterparty: publicUser(user), reference_id: reference, reference_type: 'credit_transfer', created_by: user.id, created_at: now()});
      notification(recipient.id, 'credit_transfer', `${user.profile.display_name || user.username} sent you ${amount} time credits.`);
      persist(); return response({message: 'Credit payment recorded.', balance: user.time_credits});
    }
    if (path === '/api/credits/disputes' && method === 'POST') {
      const denied = requireUser(); if (denied) return denied;
      const dispute = {id: id('dispute'), user_id: user.id, ledger_entry_id: body.ledger_entry_id || '', reason: body.reason || 'Other', details: body.details || '', status: 'open', created_at: now()};
      store.disputes.push(dispute); persist(); return response({message: 'Credit dispute opened.', dispute});
    }

    if (path === '/api/journal' && method === 'GET') {
      const denied = requireUser(); if (denied) return denied;
      const entries = store.journals.filter(item => item.user_id === user.id);
      return response({
        entries,
        goals: [],
        stats: {
          entries: entries.length,
          hours: Math.round(entries.reduce((sum, item) => sum + Number(item.minutes || 0), 0) / 60 * 10) / 10,
          skills: new Set(entries.map(item => item.skill).filter(Boolean)).size
        }
      });
    }
    if (path === '/api/journal' && method === 'POST') {
      const denied = requireUser(); if (denied) return denied;
      const entry = {
        id: id('journal'),
        user_id: user.id,
        title: body.title || 'Reflection',
        skill: body.skill || '',
        minutes: Number(body.minutes || body.practice_minutes || 0),
        confidence: Number(body.confidence || 3),
        mood: body.mood || 'curious',
        visibility: body.visibility || 'private',
        reflection: body.reflection || body.body || '',
        next_step: body.next_step || '',
        created_at: now()
      };
      store.journals.unshift(entry); persist(); return response({entry, message: 'Journal entry saved.'});
    }
    if (/^\/api\/journal\/[^/]+$/.test(path) && ['PATCH', 'DELETE'].includes(method)) { const denied = requireUser(); if (denied) return denied; const entry = store.journals.find(item => item.id === decodeURIComponent(path.split('/')[3]) && item.user_id === user.id); if (method === 'DELETE') store.journals = store.journals.filter(item => item !== entry); else if (entry) Object.assign(entry, body); persist(); return response({message: 'Journal updated.', entry}); }
    if (path === '/api/portfolio' && method === 'GET') { const denied = requireUser(); if (denied) return denied; const portfolio = store.portfolios[user.id] || {title: `${user.profile.display_name || user.username}'s portfolio`, headline: '', intro: '', visibility: 'private', accent: 'green', links: [], show_completed_jobs: false, show_journal: false, show_ideas: false, show_workshops: false, projects: []}; store.portfolios[user.id] = portfolio; return response({settings: portfolio, projects: portfolio.projects || [], journal: store.journals.filter(item => item.user_id === user.id)}); }
    if (path === '/api/portfolio' && method === 'PATCH') { const denied = requireUser(); if (denied) return denied; store.portfolios[user.id] = {...(store.portfolios[user.id] || {}), ...body}; persist(); return response({settings: store.portfolios[user.id], portfolio: store.portfolios[user.id], message: 'Portfolio settings saved.'}); }
    if (/^\/api\/portfolio\/items(?:\/([^/]+))?$/.test(path)) { const denied = requireUser(); if (denied) return denied; const portfolio = store.portfolios[user.id] || {projects: []}; portfolio.projects ||= []; const itemId = path.split('/')[4]; if (method === 'POST') portfolio.projects.push({id: id('project'), ...body, created_at: now()}); else if (method === 'PATCH') Object.assign(portfolio.projects.find(item => item.id === decodeURIComponent(itemId)) || {}, body); else if (method === 'DELETE') portfolio.projects = portfolio.projects.filter(item => item.id !== decodeURIComponent(itemId)); store.portfolios[user.id] = portfolio; persist(); return response({message: 'Portfolio updated.', settings: portfolio, projects: portfolio.projects, portfolio}); }

    if (path === '/api/gifts/vouchers' && method === 'GET') { const denied = requireUser(); if (denied) return denied; return response({balance: user.time_credits, vouchers: store.vouchers.filter(item => item.creator_id === user.id || item.redeemer_id === user.id)}); }
    if (path === '/api/gifts/vouchers' && method === 'POST') { const denied = requireUser(); if (denied) return denied; const amount = Math.max(1, Number(body.amount || 0)); if (amount > user.time_credits) return failure('You do not have enough time credits for that voucher.'); const code = `SA-GIFT-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`; user.time_credits -= amount; const voucher = {id: id('voucher'), creator_id: user.id, amount, status: 'active', code_preview: code.slice(0, 13) + '••••', code}; store.vouchers.push(voucher); persist(); return response({voucher, balance: user.time_credits}); }
    if (path === '/api/gifts/vouchers/redeem' && method === 'POST') { const denied = requireUser(); if (denied) return denied; const voucher = store.vouchers.find(item => item.code === String(body.code || '').trim() && item.status === 'active'); if (!voucher) return failure('That voucher was not found or has already been redeemed.'); voucher.status = 'redeemed'; voucher.redeemer_id = user.id; user.time_credits += Number(voucher.amount); persist(); return response({amount: voucher.amount, balance: user.time_credits}); }

    if (path === '/api/workshops' && method === 'GET') {
      let workshopSharesChanged = false;
      const workshops = store.workshops.filter(item => item.status !== 'cancelled').map(workshop => {
        if (ensureWorkshopShare(workshop)) workshopSharesChanged = true;
        return workshopView(workshop);
      });
      if (workshopSharesChanged) persist();
      return response({workshops, categories: [...new Set(workshops.map(item => item.category).filter(Boolean))], stats: {scheduled: workshops.filter(item => item.status === 'scheduled').length, seats: workshops.reduce((sum, item) => sum + item.seats_remaining, 0), registered: workshops.reduce((sum, item) => sum + item.registered_count, 0), hosts: new Set(workshops.map(item => item.host_id)).size}});
    }
    if (path === '/api/workshops' && method === 'POST') {
      const denied = requireUser(); if (denied) return denied;
      const completionGate = profileCompletionGate(user, 'workshops.html'); if (completionGate) return completionGate;
      const starts = body.starts_at || new Date(Date.now() + 86400000).toISOString();
      const event = {id: id('event'), title: body.title || 'SwapLabs workshop', description: body.description || '', starts_at: starts, ends_at: new Date(new Date(starts).getTime() + Number(body.duration_minutes || 60) * 60000).toISOString(), timezone: body.timezone || user.profile.timezone || 'UTC', host_id: user.id, participant_ids: [], status: 'scheduled', location: body.location || '', meeting_url: body.meeting_url || '', reminders_minutes: [60], all_day: false};
      const workshop = {id: id('workshop'), event_id: event.id, host_id: user.id, title: body.title || 'SwapLabs workshop', description: body.description || '', category: body.category || 'Learning', level: body.level || 'All levels', format: body.format || 'Online', location: body.location || '', timezone: event.timezone, starts_at: starts, ends_at: event.ends_at, duration_minutes: Number(body.duration_minutes || 60), seat_limit: Number(body.seat_limit || 20), status: 'scheduled', registered_user_ids: [], outcomes: asList(body.outcomes), tags: asList(body.tags), share_id: newWorkshopShareId(), share_expires_at: event.ends_at};
      store.events.push(event); store.workshops.push(workshop); persist(); return response({workshop: workshopView(workshop), event_id: event.id, message: 'Workshop published.'});
    }
    const workshopShareMatch = path.match(/^\/api\/workshops\/share\/([^/]+)$/);
    if (workshopShareMatch && method === 'GET') {
      const shareId = decodeURIComponent(workshopShareMatch[1]);
      const workshop = store.workshops.find(item => item.share_id === shareId);
      if (!workshop) return failure('This workshop link is invalid or has expired.', 404, {code: 'workshop_link_invalid'});
      if (ensureWorkshopShare(workshop)) persist();
      const expiresAt = workshop.share_expires_at || workshopEndAt(workshop);
      if (workshop.status !== 'scheduled' || !expiresAt || new Date(expiresAt).getTime() <= Date.now()) {
        return response({error: 'This workshop link has expired because the workshop has already happened.', code: 'workshop_link_expired', expired_at: expiresAt || null}, 410);
      }
      return response({workshop: workshopView(workshop), share_id: shareId, share_expires_at: expiresAt, share_url: `${location.origin}/workshops.html?share=${encodeURIComponent(shareId)}`});
    }
    if (/^\/api\/workshops\/[^/]+\/register$/.test(path) && ['POST', 'DELETE'].includes(method)) {
      const denied = requireUser(); if (denied) return denied;
      const completionGate = profileCompletionGate(user, 'workshops.html'); if (completionGate) return completionGate;
      const workshop = store.workshops.find(item => item.id === decodeURIComponent(path.split('/')[3]));
      if (!workshop) return failure('Workshop not found.', 404);
      if (method === 'POST' && new Date(workshop.starts_at || '').getTime() <= Date.now()) return failure('Registration is closed because this workshop has started.', 410, {code: 'workshop_registration_closed'});
      workshop.registered_user_ids ||= [];
      if (method === 'POST' && !workshop.registered_user_ids.includes(user.id)) {
        if (workshop.registered_user_ids.length >= Number(workshop.seat_limit || 20)) return failure('This workshop is full.');
        workshop.registered_user_ids.push(user.id);
      }
      if (method === 'DELETE') workshop.registered_user_ids = workshop.registered_user_ids.filter(idValue => idValue !== user.id);
      persist(); return response({workshop: workshopView(workshop), message: method === 'POST' ? 'Your place is reserved.' : 'Your workshop place was cancelled.'});
    }
    if (path === '/api/courses' && method === 'GET') {
      const publicCourses = store.courses
        .filter(item => item.visibility === 'public' && item.status === 'published')
        .sort((first, second) => String(second.published_at || second.created_at || '').localeCompare(String(first.published_at || first.created_at || '')))
        .map(courseView);
      const mine = user ? store.courses
        .filter(item => item.owner_id === user.id)
        .sort((first, second) => String(second.updated_at || second.created_at || '').localeCompare(String(first.updated_at || first.created_at || '')))
        .map(courseView) : [];
      return response({
        courses: publicCourses,
        mine,
        categories: [...new Set(publicCourses.map(item => item.category).filter(Boolean))].sort((first, second) => first.localeCompare(second)),
        stats: {
          published: publicCourses.length,
          lessons: publicCourses.reduce((total, item) => total + Number(item.lesson_count || 0), 0),
          creators: new Set(publicCourses.map(item => item.owner_id).filter(Boolean)).size
        }
      });
    }
    if (path === '/api/courses' && method === 'POST') {
      const denied = requireUser(); if (denied) return denied;
      if (user.status !== 'active') return failure('Your account cannot publish courses right now.', 403);
      const input = courseInput(body);
      if (input.errors.length) return failure(input.errors[0], 400, {errors: input.errors});
      const timestamp = now();
      const course = {
        id: id('course'), owner_id: user.id, title: input.title, description: input.description,
        category: input.category, level: input.level, estimated_hours: input.estimated_hours,
        resource_url: input.resource_url, lessons: input.lessons, visibility: input.visibility,
        status: input.visibility === 'public' ? 'published' : 'draft',
        created_at: timestamp, updated_at: timestamp,
        published_at: input.visibility === 'public' ? timestamp : null
      };
      store.courses.unshift(course);
      persist();
      return response({course: courseView(course), message: course.status === 'published' ? 'Your course is public.' : 'Your course was saved as a draft.'}, 201);
    }
    const courseMatch = path.match(/^\/api\/courses\/([^/]+)$/);
    if (courseMatch && ['PATCH', 'DELETE'].includes(method)) {
      const denied = requireUser(); if (denied) return denied;
      const course = store.courses.find(item => item.id === decodeURIComponent(courseMatch[1]));
      if (!course) return failure('Course not found.', 404);
      if (course.owner_id !== user.id && user.role !== 'admin') return failure('You do not have permission to change this course.', 403);
      if (method === 'DELETE') {
        store.courses = store.courses.filter(item => item !== course);
        persist();
        return response({message: 'Course removed.'});
      }
      const input = courseInput({...course, ...body});
      if (input.errors.length) return failure(input.errors[0], 400, {errors: input.errors});
      const timestamp = now();
      Object.assign(course, input, {
        status: input.visibility === 'public' ? 'published' : 'draft',
        updated_at: timestamp,
        published_at: input.visibility === 'public' ? (course.published_at || timestamp) : null
      });
      persist();
      return response({course: courseView(course), message: course.status === 'published' ? 'Your course is public.' : 'Your course was saved as a draft.'});
    }
    if (path === '/api/livestreams' && method === 'GET') return response({livestreams: store.livestreams, my_livestreams: user ? store.livestreams.filter(item => item.host_id === user.id) : [], categories: [], stats: {live: 0, viewers: 0, credits_donated: 0}});
    if (path === '/api/livestreams' && method === 'POST') { const denied = requireUser(); if (denied) return denied; const stream = {id: id('stream'), host_id: user.id, title: body.title || 'SwapLabs live session', description: body.description || '', category: body.category || 'Community', tags: asList(body.tags), scheduled_at: body.scheduled_at, status: 'scheduled', host: publicUser(user), viewer_count: 0, credits_donated: 0}; store.livestreams.push(stream); persist(); return response({livestream: stream}); }
    const streamMatch = path.match(/^\/api\/livestreams\/([^/]+)(?:\/(.*))?$/); if (streamMatch) { const denied = requireUser(); if (denied) return denied; const stream = store.livestreams.find(item => item.id === decodeURIComponent(streamMatch[1])); if (!stream) return failure('Broadcast not found.', 404); const action = streamMatch[2] || ''; if (!action && method === 'GET') return response({livestream: stream, chat: []}); if (['start', 'end'].includes(action)) { stream.status = action === 'start' ? 'live' : 'ended'; persist(); return response({livestream: stream}); } if (action === 'join' || action === 'leave' || action === 'heartbeat') return response({livestream: stream}); if (action === 'chat') return response({message: {body: body.body || '', created_at: now(), author: publicUser(user)}}); if (action === 'signals') return response({signals: []}); if (method === 'PATCH') { Object.assign(stream, body); persist(); return response({livestream: stream}); } }

    if (path === '/api/ideas' && method === 'GET') {
      const ideas = store.ideas.filter(isPublicIdea).map(ideaView);
      return response({ideas, stats: ideaStats(ideas)});
    }
    if (path === '/api/ideas' && method === 'POST') {
      const denied = requireUser(); if (denied) return denied;
      const studentSubmission = Boolean(user.safety?.is_minor);
      const idea = {
        id: id('idea'), title: String(body.title || 'Untitled idea').trim(),
        summary: String(body.summary || body.tagline || body.problem || '').trim(),
        tagline: String(body.tagline || body.summary || '').trim(), category: String(body.category || 'Open category').trim(),
        stage: String(body.stage || 'Early idea').trim(), problem: String(body.problem || '').trim(),
        solution: String(body.solution || '').trim(), beneficiaries: String(body.beneficiaries || '').trim(),
        impact: String(body.impact || '').trim(), funding_currency: String(body.funding_currency || 'time credits').trim(),
        funding_needed: Math.max(0, Number(body.funding_needed || 0)), funds_use: String(body.funds_use || '').trim(),
        skills_needed: asList(body.skills_needed), collaboration: String(body.collaboration || '').trim(),
        reach: String(body.reach || '').trim(), prototype_url: String(body.prototype_url || '').trim(),
        pitch: String(body.pitch || '').trim(), status: studentSubmission ? 'specialist_review' : 'published',
        owner_id: user.id, owner_age_group: studentSubmission ? 'minor' : 'adult',
        safety_review_status: studentSubmission ? 'pending' : 'not required',
        guardian_consent_status: user.safety?.guardian_consent_status || (studentSubmission ? 'pending' : 'not required'),
        specialist_reviewer_id: '', moderation_notes: '', created_at: now(),
        like_count: 0, save_count: 0, comment_count: 0, like_user_ids: [], save_user_ids: [], comments: [], pledges: []
      };
      store.ideas.unshift(idea); persist();
      return response({idea: ideaView(idea), message: studentSubmission ? 'Your idea was submitted for specialist review.' : 'Your idea is now published.'});
    }
    const ideaAction = path.match(/^\/api\/ideas\/([^/]+)\/(like|save)$/);
    if (ideaAction && ['POST', 'DELETE'].includes(method)) {
      const denied = requireUser(); if (denied) return denied;
      const idea = store.ideas.find(item => item.id === decodeURIComponent(ideaAction[1]));
      if (!idea) return failure('That idea could not be found.', 404);
      const action = ideaAction[2];
      const ids = action === 'like' ? (idea.like_user_ids ||= []) : (idea.save_user_ids ||= []);
      const index = ids.indexOf(user.id);
      const shouldHaveAction = method === 'POST' ? index < 0 : false;
      if (shouldHaveAction) {
        ids.push(user.id);
        const field = action === 'like' ? 'like_count' : 'save_count';
        idea[field] = Math.max(0, Number(idea[field] || 0)) + 1;
      } else if (index >= 0) {
        ids.splice(index, 1);
        const field = action === 'like' ? 'like_count' : 'save_count';
        idea[field] = Math.max(0, Number(idea[field] || 0) - 1);
      }
      persist();
      const view = ideaView(idea);
      return response({
        idea: view, liked: view.viewer_liked, saved: view.viewer_saved,
        like_count: view.like_count, save_count: view.save_count,
        message: action === 'like' ? (view.viewer_liked ? 'Idea supported.' : 'Support removed.') : (view.viewer_saved ? 'Idea saved.' : 'Idea removed from saved items.')
      });
    }
    const ideaComments = path.match(/^\/api\/ideas\/([^/]+)\/comments(?:\/([^/]+))?$/);
    if (ideaComments && ['GET', 'POST', 'DELETE'].includes(method)) {
      const idea = store.ideas.find(item => item.id === decodeURIComponent(ideaComments[1]));
      if (!idea) return failure('That idea could not be found.', 404);
      idea.comments ||= [];
      if (method === 'GET') return response({comments: ideaView(idea).comments});
      const denied = requireUser(); if (denied) return denied;
      if (method === 'DELETE') {
        const commentId = decodeURIComponent(ideaComments[2] || '');
        const comment = idea.comments.find(item => item.id === commentId);
        if (!comment) return failure('That comment could not be found.', 404);
        const canDelete = user.role === 'admin' || comment.author_id === user.id || idea.owner_id === user.id;
        if (!canDelete) return failure('You do not have permission to remove that comment.', 403);
        idea.comments = idea.comments.filter(item => item.id !== commentId);
        idea.comment_count = Math.max(0, Number(idea.comment_count || 0) - 1);
        persist(); return response({message: 'Comment removed.', idea: ideaView(idea)});
      }
      const message = bodyMessage(body);
      if (!message) return failure('Write a comment before posting.');
      if (message.length > 1200) return failure('Comments must be 1,200 characters or fewer.');
      const comment = {id: id('idea-comment'), idea_id: idea.id, author_id: user.id, message, created_at: now()};
      idea.comments.push(comment);
      idea.comment_count = Math.max(0, Number(idea.comment_count || 0)) + 1;
      persist(); return response({message: 'Comment added.', comment: ideaView({...idea, comments: [comment]}).comments[0], idea: ideaView(idea)});
    }
    const adminIdeaPath = path.match(/^\/api\/admin\/ideas\/([^/]+)$/);
    if (adminIdeaPath && ['PATCH', 'DELETE'].includes(method)) {
      if (!user || user.role !== 'admin') return failure('Operations access is required.', 403);
      const ideaId = decodeURIComponent(adminIdeaPath[1]);
      const idea = store.ideas.find(item => item.id === ideaId);
      if (!idea) return failure('That idea could not be found.', 404);
      if (method === 'DELETE') {
        store.ideas = store.ideas.filter(item => item.id !== ideaId);
        persist(); return response({message: 'Idea deleted permanently.', content: adminContentView()});
      }
      const textFields = ['title', 'tagline', 'category', 'stage', 'problem', 'solution', 'beneficiaries', 'impact', 'funding_currency', 'funds_use', 'collaboration', 'reach', 'prototype_url', 'pitch', 'status', 'moderation_notes'];
      textFields.forEach(field => { if (body[field] !== undefined) idea[field] = String(body[field] || '').trim(); });
      if (body.funding_needed !== undefined) idea.funding_needed = Math.max(0, Number(body.funding_needed) || 0);
      if (body.skills_needed !== undefined) idea.skills_needed = asList(body.skills_needed);
      idea.updated_at = now();
      persist(); return response({message: 'Idea changes saved.', content: adminContentView(), idea: ideaView(idea)});
    }
    if (path === '/api/funding' && method === 'GET') return response({ideas: store.ideas, requests: []});
    if (path === '/api/mentor/dashboard' && method === 'GET') {
      const denied = requireUser(); if (denied) return denied;
      return response({stats: {sessions: 0, learners: 0, credits: 0}, sessions: [], workshops: [], marketplace_items: [], application: null, applications: []});
    }
    if (path === '/api/mentor/application' && method === 'POST') { const denied = requireUser(); if (denied) return denied; return response({message: 'Mentor application saved for review.', application: {status: 'pending'}}); }
    if (path === '/api/student-safety' && method === 'GET') {
      const denied = requireUser(); if (denied) return denied;
      return response({authenticated: true, stats: {controls: 4, protected_accounts: 0, pending_reviews: 0}, controls: ['Guardian consent for minors', 'Age-appropriate discovery and messaging', 'Report, block, and moderation controls', 'Audit trails for safeguarding decisions'], safety: user.safety, user: accountUser(user)});
    }
    if (path === '/api/student-safety/guardian-consent' && method === 'POST') { const denied = requireUser(); if (denied) return denied; user.safety = {...user.safety, ...body, guardian_consent_status: 'pending'}; persist(); return response({message: 'Guardian consent details saved.', safety: user.safety}); }
    if (path === '/api/moderation/center' && method === 'GET') { const denied = requireUser(); if (denied) return denied; return response({stats: {open_reports: 0, student_reviews: 0, mentor_applications: 0}, reports: [], student_ideas: [], mentor_applications: []}); }
    if (path === '/api/roadmap' && method === 'GET') return response({stats: {planned: 0, in_progress: 0, shipped: 0}, items: []});
    if (path === '/api/skill-battle' && method === 'GET') return response({battles: [], entries: []});
    if (path === '/api/marketplace' && method === 'GET') return response({items: [], my_orders: [], authenticated: Boolean(user), balance: user?.time_credits || 0, stats: {offers: 0, orders: 0, credits_moved: 0}});
    if (path === '/api/session-room' && method === 'GET') {
      const denied = requireUser(); if (denied) return denied;
      const events = store.events.filter(item => item.host_id === user.id || item.participant_ids?.includes(user.id)).map(event => eventView(event));
      return response({events, rooms: [], stats: {sessions: events.length, rooms: 0, attendance: 0}});
    }
    const localVideoPath = path.match(/^\/api\/video\/rooms(?:\/([^/]+)(?:\/(join|leave|signals|attendance))?)?$/);
    if (localVideoPath) {
      const denied = requireUser(); if (denied) return denied;
      const roomId = localVideoPath[1] ? decodeURIComponent(localVideoPath[1]) : '';
      const action = localVideoPath[2] || 'detail';
      if (!roomId && method === 'POST') {
        const participantIds = [...new Set([user.id, ...asList(body.participant_ids)])];
        const hostId = user.id; const createdAt = now();
        const room = {id: id('room'), owner_id: user.id, host_id: hostId, title: String(body.title || 'SwapLabs video room').slice(0, 180), status: 'ready', waiting_room_enabled: body.waiting_room_enabled !== false, screen_sharing_enabled: body.screen_sharing_enabled !== false, video_enabled: body.video_enabled !== false, audio_enabled: body.audio_enabled !== false, call_mode: body.call_mode || 'video', participant_ids: participantIds, attendance: participantIds.map(memberId => ({user_id: memberId, state: memberId === hostId ? 'admitted' : 'invited', joined_at: null, left_at: null, duration_seconds: 0, participant_confirmed: false, host_confirmed: memberId === hostId})), signals: [], created_at: createdAt};
        store.video_rooms.unshift(room); persist(); return response({room: videoRoomViewLocal(room), signals: [], message: 'Room ready in local demo mode.'}, 201);
      }
      const room = store.video_rooms.find(item => item.id === roomId);
      if (!room) return failure('Video room not found.', 404);
      if (!room.participant_ids.includes(user.id)) return failure('You are not invited to this room.', 403);
      if (action === 'detail' && method === 'GET') return response({room: videoRoomViewLocal(room), signals: room.signals || []});
      const record = room.attendance.find(item => item.user_id === user.id) || {user_id: user.id, state: 'invited', joined_at: null, left_at: null, duration_seconds: 0};
      if (!room.attendance.some(item => item.user_id === user.id)) room.attendance.push(record);
      if (action === 'join' && method === 'POST') { record.state = room.host_id === user.id ? 'admitted' : 'waiting'; record.join_requested_at = now(); if (record.state === 'admitted') record.joined_at = record.joined_at || now(); persist(); return response({room: videoRoomViewLocal(room), signals: room.signals || []}); }
      if (action === 'leave' && method === 'POST') { record.state = 'left'; record.left_at = now(); persist(); return response({room: videoRoomViewLocal(room)}); }
      if (action === 'attendance' && method === 'POST') { const requested = String(body.action || ''); if (requested === 'joined') record.state = room.host_id === user.id ? 'in_call' : record.state; if (requested === 'left') record.state = 'left'; if (requested === 'confirm') record.participant_confirmed = true; persist(); return response({room: videoRoomViewLocal(room)}); }
      if (action === 'signals' && ['GET', 'POST'].includes(method)) { if (method === 'POST') room.signals.push({id: id('signal'), sender_id: user.id, target_id: body.target_id || null, type: String(body.type || '').slice(0, 80), payload: body.payload && typeof body.payload === 'object' ? body.payload : {}, created_at: now()}); const after = new URL(requestUrl).searchParams.get('after') || ''; const visible = room.signals.filter(signal => (!after || String(signal.created_at) > after) && (!signal.target_id || signal.target_id === user.id || signal.sender_id === user.id)); persist(); return response({room: videoRoomViewLocal(room), signals: visible, server_time: now()}); }
      return failure('Unsupported video room action.', 400);
    }
    if (path === '/api/swapjobs' && method === 'GET') return response({jobs: store.swapjobs, mine: user ? store.swapjobs.filter(item => item.owner_id === user.id) : [], my_proposals: [], categories: [], stats: {open: 0, completed: 0}, matches: []});
    if (path === '/api/swapjobs' && method === 'POST') { const denied = requireUser(); if (denied) return denied; const job = {id: id('job'), owner_id: user.id, owner: publicUser(user), title: body.title || 'Untitled task', description: body.description || '', skills_needed: asList(body.skills_needed), status: 'open', proposal_count: 0, created_at: now()}; store.swapjobs.unshift(job); persist(); return response({job, message: 'Task posted.'}); }

    if (path === '/api/organizations/overview' && method === 'GET') { const denied = requireUser(); if (denied) return denied; return response({organization: null, policy: {allow_external_access: true, blocked_categories: []}, members: [], activity: []}); }
    if (path === '/api/organizations/register' && method === 'POST') { const denied = requireUser(); if (denied) return denied; return response({message: 'Organization registration saved.', organization: {id: id('org'), name: body.name || 'SwapLabs circle'}}); }
    if (path === '/api/organizations/members' && method === 'POST') { const denied = requireUser(); if (denied) return denied; return response({message: 'Member account created.'}); }
    if (path === '/api/organizations/policy' && method === 'PATCH') { const denied = requireUser(); if (denied) return denied; return response({message: 'Organization policy saved.'}); }

    if (path === '/api/admin/presence/today' && method === 'GET') {
      if (!user || user.role !== 'admin') return failure('Operations access is required.', 403);
      const requestedSince = Date.parse(url.searchParams.get('since') || '');
      const nowMs = Date.now();
      const fallbackStart = new Date(nowMs);
      fallbackStart.setHours(0, 0, 0, 0);
      const dayStart = Number.isFinite(requestedSince) && requestedSince <= nowMs + 24 * 60 * 60 * 1000 && requestedSince >= nowMs - 48 * 60 * 60 * 1000 ? requestedSince : fallbackStart.getTime();
      const cutoff = nowMs - ONLINE_PRESENCE_WINDOW_SECONDS * 1000;
      const current = store.presence || {};
      const byUser = new Map();
      Object.values(store.presence_days || {}).forEach(record => {
        const lastSeenMs = Date.parse(record?.last_seen_at);
        if (!record || !Number.isFinite(lastSeenMs) || lastSeenMs < dayStart) return;
        const member = store.users.find(item => item.id === record.user_id);
        if (!member || member.status !== 'active') return;
        const currentRecord = current[member.id];
        const currentSeenMs = Date.parse(currentRecord?.last_seen_at);
        const isOnline = Boolean(currentRecord) && Number.isFinite(currentSeenMs) && currentSeenMs >= cutoff;
        const safe = accountUser(member);
        const displayName = safe?.profile?.display_name || member.username;
        const view = {
          id: member.id,
          username: member.username,
          display_name: displayName,
          role: member.role === 'admin' ? 'admin' : 'member',
          status: member.status,
          profile: {
            display_name: displayName,
            profile_color: safe?.profile?.profile_color || 'indigo',
            avatar_url: safe?.profile?.avatar_url || ''
          },
          page_path: safePresencePage(isOnline ? currentRecord.page_path : record.page_path),
          last_seen_at: record.last_seen_at,
          seconds_since_seen: Number.isFinite(lastSeenMs) ? Math.max(0, Math.floor((nowMs - lastSeenMs) / 1000)) : null,
          is_online: isOnline
        };
        const existing = byUser.get(member.id);
        if (!existing || String(view.last_seen_at).localeCompare(String(existing.last_seen_at)) > 0) byUser.set(member.id, view);
      });
      const users = [...byUser.values()].sort((left, right) => String(right.last_seen_at).localeCompare(String(left.last_seen_at)));
      return response({ok: true, checked_at: now(), day_start: new Date(dayStart).toISOString(), online_window_seconds: ONLINE_PRESENCE_WINDOW_SECONDS, users});
    }
    if (path === '/api/admin/presence' && method === 'GET') {
      if (!user || user.role !== 'admin') return failure('Operations access is required.', 403);
      const cutoff = Date.now() - ONLINE_PRESENCE_WINDOW_SECONDS * 1000;
      const users = Object.values(store.presence || {}).map(record => {
        const member = store.users.find(item => item.id === record.user_id);
        if (!member || member.status !== 'active') return null;
        const safe = accountUser(member);
        const displayName = safe?.profile?.display_name || member.username;
        const lastSeenMs = Date.parse(record.last_seen_at);
        return {
          id: member.id,
          username: member.username,
          display_name: displayName,
          role: member.role === 'admin' ? 'admin' : 'member',
          status: member.status,
          profile: {
            display_name: displayName,
            profile_color: safe?.profile?.profile_color || 'indigo',
            avatar_url: safe?.profile?.avatar_url || ''
          },
          page_path: safePresencePage(record.page_path),
          last_seen_at: record.last_seen_at,
          seconds_since_seen: Number.isFinite(lastSeenMs) ? Math.max(0, Math.floor((Date.now() - lastSeenMs) / 1000)) : null
        };
      }).filter(Boolean).sort((left, right) => String(right.last_seen_at).localeCompare(String(left.last_seen_at)));
      return response({ok: true, checked_at: now(), active_window_seconds: ONLINE_PRESENCE_WINDOW_SECONDS, users});
    }
    if (path === '/api/admin/overview' && method === 'GET') {
      if (!user || user.role !== 'admin') return failure('Operations access is required.', 403);
      const memberUsers = store.users.filter(item => item.role !== 'admin');
      const activeMembers = memberUsers.filter(item => item.status !== 'suspended');
      const suspendedMembers = memberUsers.filter(item => item.status === 'suspended');
      const verifiedMembers = memberUsers.filter(item => item.verified === true);
      const totalCredits = memberUsers.reduce((sum, item) => sum + Number(item.time_credits || 0), 0);
      return response({
        stats: {
          total: store.users.length,
          members: memberUsers.length,
          active: activeMembers.length,
          suspended: suspendedMembers.length,
          verified: verifiedMembers.length,
          credits: totalCredits,
          // Keep the descriptive aliases available to any alternate admin UI.
          total_accounts: store.users.length,
          member_accounts: memberUsers.length,
          active_accounts: activeMembers.length,
          verified_profiles: verifiedMembers.length,
          total_time_credits: totalCredits,
          open_reports: store.reports.filter(item => !['resolved', 'dismissed'].includes(item.status)).length,
          pending_submissions: 0,
          messages: store.adminMessages.length
        },
        users: store.users.map(accountUser),
        recent_activity: [],
        audit_log: [],
        analytics: {}
      });
    }
    if (path === '/api/admin/users' && method === 'GET') { if (!user || user.role !== 'admin') return failure('Operations access is required.', 403); return response({users: store.users.map(accountUser)}); }
    if (path === '/api/admin/content' && method === 'GET') {
      if (!user || user.role !== 'admin') return failure('Operations access is required.', 403);
      return response(adminContentView());
    }
    const adminSessionReviewPath = path.match(/^\/api\/admin\/session-reviews(?:\/([^/]+))?$/);
    if (adminSessionReviewPath && ['GET', 'PATCH'].includes(method)) {
      if (!user || user.role !== 'admin') return failure('Operations access is required.', 403);
      if (method === 'GET' && !adminSessionReviewPath[1]) {
        return response({reviews: (store.session_point_reviews || []).map(adminSessionReviewView)});
      }
      const review = (store.session_point_reviews || []).find(item => item.id === decodeURIComponent(adminSessionReviewPath[1] || ''));
      if (!review) return failure('That session point review could not be found.', 404);
      if (method === 'GET') return response({review: adminSessionReviewView(review)});
      if (review.status !== 'pending') return failure('That session review already has a final administrator decision.', 409);
      const decision = String(body.decision || '').toLowerCase();
      if (!['approve', 'deny'].includes(decision)) return failure('Choose whether to approve or deny the session points.', 400);
      const event = store.events.find(item => item.id === review.event_id);
      const ratings = sessionRatingsFor(review.event_id);
      if (decision === 'approve') {
        ratings.forEach(awardSessionPoints);
        review.status = 'approved';
        if (event) {
          event.points_status = 'awarded';
          event.points_review_id = review.id;
        }
      } else {
        ratings.forEach(revokeSessionPoints);
        review.status = 'denied';
        if (event) {
          event.points_status = 'withheld';
          event.points_review_id = review.id;
        }
      }
      review.admin_id = user.id;
      review.admin_notes = String(body.admin_notes || '').trim().slice(0, 2000);
      review.decided_at = now();
      review.updated_at = review.decided_at;
      persist();
      return response({message: decision === 'approve' ? 'Session points approved and awarded privately.' : 'Session points denied and withheld privately.', review: adminSessionReviewView(review)});
    }
    if (path === '/api/admin/operations' && method === 'GET') {
      if (!user || user.role !== 'admin') return failure('Operations access is required.', 403);
      const sessionPointReviews = (store.session_point_reviews || []).map(adminSessionReviewView);
      return response({
        stats: {conversations: store.conversations.length, messages: store.messages.length, open_reports: 0, scheduled_events: store.events.filter(item => item.status === 'scheduled').length, ledger_entries: store.ledger.length, open_disputes: 0, pending_session_point_reviews: sessionPointReviews.filter(item => item.status === 'pending').length},
        messages: [], reports: [], disputes: store.disputes, sessions: store.events.map(adminEventView), events: store.events.map(adminEventView), session_point_reviews: sessionPointReviews,
        activity: store.users.filter(item => item.role !== 'admin').map(item => ({user: accountUser(item), messages_sent: store.messages.filter(message => message.sender_id === item.id).length, reports_received: 0, open_reports: 0, calendar_events: store.events.filter(event => event.host_id === item.id).length, ledger_entries: store.ledger.filter(entry => entry.user_id === item.id).length, last_message_at: null})),
        ledger: store.ledger, audit: []
      });
    }
    if (path === '/api/admin/newsletter' && method === 'GET') return response({subscribers: []});
    const adminContentMatch = path.match(/^\/api\/admin\/content\/(contacts|complaints|feedback|workshops|registrations)\/([^/]+)$/);
    if (adminContentMatch && ['PATCH', 'DELETE'].includes(method)) {
      if (!user || user.role !== 'admin') return failure('Operations access is required.', 403);
      const collection = adminContentMatch[1];
      const recordId = decodeURIComponent(adminContentMatch[2]);
      const storeKeyByCollection = {contacts: 'contact_messages', complaints: 'complaints', feedback: 'feedback', workshops: 'workshops', registrations: 'workshop_registrations'};
      const collectionKey = storeKeyByCollection[collection];
      const records = store[collectionKey] || [];
      const item = records.find(record => record.id === recordId);
      if (!item) return failure('That submission record was not found.', 404);
      if (method === 'DELETE') {
        store[collectionKey] = records.filter(record => record.id !== recordId);
        if (collection === 'registrations') {
          const workshop = store.workshops.find(record => record.id === item.workshop_id);
          if (workshop) workshop.registered_user_ids = (workshop.registered_user_ids || []).filter(memberId => memberId !== item.user_id);
        }
        persist();
        return response({message: 'Submission record deleted.', content: adminContentView()});
      }
      if (collection === 'contacts') {
        ['status', 'admin_notes'].forEach(field => { if (body[field] !== undefined) item[field] = String(body[field] || ''); });
      } else if (collection === 'complaints') {
        ['status', 'priority', 'admin_notes'].forEach(field => { if (body[field] !== undefined) item[field] = String(body[field] || ''); });
      } else if (collection === 'feedback') {
        ['title', 'message', 'role', 'admin_notes'].forEach(field => { if (body[field] !== undefined) item[field] = String(body[field] || ''); });
        if (body.rating !== undefined) item.rating = Math.max(1, Math.min(5, Number(body.rating) || 1));
        if (body.status !== undefined) item.status = String(body.status || 'private');
        if (body.featured !== undefined) item.featured = body.featured === true || body.featured === 'true' || body.featured === 'on';
        if (!item.permission_to_publish && item.status === 'published') item.status = 'private';
      } else if (collection === 'workshops') {
        ['title', 'description', 'location', 'admin_notes', 'status'].forEach(field => { if (body[field] !== undefined) item[field] = String(body[field] || ''); });
      } else if (collection === 'registrations') {
        if (body.status !== undefined) {
          const nextStatus = String(body.status || 'registered');
          const workshop = store.workshops.find(record => record.id === item.workshop_id);
          item.status = nextStatus;
          item.admin_notes = body.admin_notes !== undefined ? String(body.admin_notes || '') : item.admin_notes || '';
          if (workshop) {
            workshop.registered_user_ids = (workshop.registered_user_ids || []).filter(memberId => memberId !== item.user_id);
            if (nextStatus === 'registered') workshop.registered_user_ids.push(item.user_id);
          }
        } else if (body.admin_notes !== undefined) item.admin_notes = String(body.admin_notes || '');
      }
      item.updated_at = now();
      persist();
      return response({message: 'Submission changes saved.', content: adminContentView()});
    }
    if (path.startsWith('/api/admin/')) { if (!user || user.role !== 'admin') return failure('Operations access is required.', 403); return response({message: 'Operations update saved in local demo mode.', users: store.users.map(accountUser), items: []}); }

    if (['/api/contact', '/api/complaints', '/api/feedback', '/api/newsletter/subscribe', '/api/early-registration'].includes(path) && method === 'POST') {
      if (path === '/api/contact') {
        const record = {id: id('contact'), name: body.name || 'Anonymous visitor', email: body.email || '', user_id: user?.id || '', topic: body.topic || body.request_type || 'General question', request_type: body.request_type || '', preferred_contact: body.preferred_contact || 'Email', subject: body.subject || 'Contact request', message: body.message || '', status: 'new', admin_notes: '', created_at: now()};
        store.contact_messages.unshift(record); persist();
        return response({message: 'Your message was saved. A human response will follow when the service is connected.', reference: record.id});
      }
      if (path === '/api/complaints') {
        const record = {id: id('complaint'), name: body.name || 'Anonymous visitor', email: body.email || '', user_id: user?.id || '', request_type: body.request_type || 'complaint', category: body.category || 'Other service concern', priority: body.priority || 'standard', subject: body.subject || 'Complaint', reference: body.reference || '', details: body.details || '', resolution: body.resolution || '', status: 'received', admin_notes: '', created_at: now()};
        store.complaints.unshift(record); persist();
        const message = body.request_type === 'safety' ? 'Your safety report was received and assigned a reference.' : 'Your complaint was received and assigned a reference.';
        return response({message, reference: record.id});
      }
      if (path === '/api/feedback') {
        const permission = body.publication_permission === true || body.publication_permission === 'on' || body.permission_to_publish === true || body.permission_to_publish === 'on';
        const record = {...body, id: id('feedback'), author_id: user?.id || '', rating: Number(body.rating || 0), created_at: now(), permission_to_publish: permission, publication_permission: permission, status: permission ? 'reviewing' : 'private', featured: false, admin_notes: ''};
        store.feedback.unshift(record); persist();
        return response({message: 'Your feedback was saved.', reference: record.id});
      }
      return response({message: 'Your message was saved. A human response will follow when the service is connected.', reference: id('ref')});
    }
    if (path === '/api/swapbot/ask' && method === 'POST') return response({answer: 'Local demo mode can show your saved dashboard counts. Connect the production API to enable live assistant context.'});

    const denied = requireUser();
    return denied || response({message: 'This action is available in local demo mode.', items: [], records: [], data: []});
  }

  nativeFetch = window.fetch.bind(window);
  const localStateBootstrap = (async () => {
    if (!LOCAL_HOSTNAMES.has(location.hostname) || window.RELAYSKILLS_USE_REMOTE_API === true) return;
    try {
      const saved = await nativeFetch(LOCAL_STATE_ENDPOINT, {cache: 'no-store'});
      if (!saved.ok) return;
      const payload = await saved.json();
      localServerReady = true;
      if (payload?.state && typeof payload.state === 'object') {
        store = {...defaults, ...payload.state};
        normalizeStore();
        try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (_error) { /* The SQL file remains authoritative. */ }
        if (localBrandMigrated || localConversationMigrated) await persist();
      } else {
        await persist();
      }
    } catch (_error) {
      localServerReady = false;
    }
  })();
  window.fetch = async (resource, init = {}) => {
    const requestUrl = typeof resource === 'string' ? resource : resource?.url || '';
    const isApi = new URL(requestUrl, location.origin).pathname.startsWith('/api/');
    if (!isApi) return nativeFetch(resource, init);
    if (LOCAL_HOSTNAMES.has(location.hostname) && window.RELAYSKILLS_USE_REMOTE_API !== true) {
      await localStateBootstrap;
      const localResponse = await route(resource, init);
      await persistenceQueue;
      return localResponse;
    }
    try {
      const real = await nativeFetch(resource, init);
      // Never turn a hosted API failure into a browser-only localStorage write.
      // That made features look successful in one browser while the production
      // database stayed unchanged. Local emulation is intentionally limited to
      // localhost; a deployed response is always the source of truth.
      return real;
    } catch (_error) {
      return new Response(JSON.stringify({error: 'The SwapLabs service could not be reached.'}), {
        status: 503,
        headers: {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'}
      });
    }
  };
  window.SwapLabsLocalAPI = {
    reset: async () => { store = {...defaults}; await persist(); location.reload(); },
    store: () => store,
    storage: () => ({backend: localServerReady ? 'sqlite' : 'browser-mirror', local: LOCAL_HOSTNAMES.has(location.hostname)})
  };
})();
