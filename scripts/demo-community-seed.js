/*
 * Local-only demo community seed.
 *
 * This fixture runs only in the local preview. It can be requested explicitly
 * from index.html with ?demo-seed=community-15, or it runs automatically when
 * the local admin entry point is opened so the admin view and the rest of the
 * preview use the same browser-local demo store. It never creates external
 * accounts.
 */
(() => {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const localHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);
  const isExplicitSeedRequest = params.get('demo-seed') === 'community-15';
  const isLocalAdminEntry = localHosts.has(window.location.hostname) && /\/admin\.html$/i.test(window.location.pathname);
  if (!isExplicitSeedRequest && !isLocalAdminEntry) return;

  const storeKey = 'relayskills-local-demo-v1';
  const seedVersion = 'relayskills-demo-community-15-v2';
  let saved = null;
  try {
    saved = JSON.parse(window.localStorage.getItem(storeKey) || 'null');
  } catch (_error) {
    saved = null;
  }
  if (saved && saved.demoCommunitySeedVersion === seedVersion) return;

  const defaults = {
    users: [], sessionUserId: '', notifications: [], conversations: [], messages: [], events: [],
    workshops: [], posts: [], stories: [], groups: [], ideas: [], journals: [], portfolios: {}, ledger: [], disputes: [],
    achievements: {}, vouchers: [], livestreams: [], swapjobs: [], follows: [], feedback: [],
    adminMessages: [], reports: [], roadmapVotes: {}, onboarding: {}
  };
  const store = Object.assign({}, defaults, saved && typeof saved === 'object' ? saved : {});
  const stamp = (day, hour) => new Date(Date.UTC(2026, 8, day, hour || 9, 0, 0)).toISOString();
  const future = (days, hour) => new Date(Date.now() + days * 86400000 + (hour || 10) * 3600000).toISOString();
  const list = value => String(value || '').split(',').map(item => item.trim()).filter(Boolean);
  const id = (prefix, number) => 'demo15-' + prefix + '-' + String(number).padStart(2, '0');
  const displayName = user => user.profile.display_name;

  const accountData = [
    {name: 'Aviraaj Oberoi', username: 'aviraaj.oberoi', password: 'Relays!2026-Avo', hash: 'ef31253646177513022d2291850ca57a7ca8dcfc29e325b37e996b079500b5f3', city: 'Delhi', teach: 'Frontend development, Figma, public speaking', learn: 'Backend development, photography', job: 'Product design student', headline: 'Making interfaces clearer and kinder', bio: 'I like turning messy ideas into calm, useful interfaces and sharing the process with other builders.', color: 'blue'},
    {name: 'Eshan Dutta', username: 'eshan.dutta', password: 'Relays!2026-Esh', hash: 'd21efab2fe1bc4106948f9ea6e06ec083766ea0f307f347f8762a2a5f1a714c9', city: 'Kolkata', teach: 'Backend development, Node.js, databases', learn: 'Product strategy, guitar', job: 'Computer science student', headline: 'Building reliable things behind the screen', bio: 'I enjoy explaining backend concepts with small projects, diagrams, and practical examples.', color: 'mint'},
    {name: 'Aarush Kohli', username: 'aarush.kohli', password: 'Relays!2026-Aar', hash: '905c0265480db345f70ed307e95450566137b2607dcb3aa8ae9351d2a6665932', city: 'Bengaluru', teach: 'Python, data analysis, Excel', learn: 'Machine learning, cooking', job: 'Data enthusiast', headline: 'Finding stories in everyday data', bio: 'I help beginners get comfortable with Python and enjoy learning by building alongside people.', color: 'lilac'},
    {name: 'Tavish Anand', username: 'tavish.anand', password: 'Relays!2026-Tav', hash: '6caca4288b5d75154f29d0b801c02435e69c1e8ac9e32fcfb6ffa243b9459ec4', city: 'Mumbai', teach: 'Guitar, music theory, songwriting', learn: 'Video editing, Hindi writing', job: 'Independent musician', headline: 'Small songs, patient practice', bio: 'I teach guitar in a relaxed, practical way and love trading creative routines with other learners.', color: 'coral'},
    {name: 'Ritvik Wadhwa', username: 'ritvik.wadhwa', password: 'Relays!2026-Rit', hash: '59773e57579b3e44c106e07c0b45e12d7f58285eb4f06855d7c0ad8b2dcf4f75', city: 'Pune', teach: 'Photography, Lightroom, composition', learn: 'UI design, storytelling', job: 'Visual storyteller', headline: 'Looking for the light in ordinary places', bio: 'I like street photography, thoughtful critique, and helping people make stronger visual choices.', color: 'violet'},
    {name: 'Yug Bedi', username: 'yug.bedi', password: 'Relays!2026-Yug', hash: '1d89876abb00d501f72e730287367682ab23eda0cc15967120ed71991356b731', city: 'Jaipur', teach: 'Grilling, Indian cooking, meal prep', learn: 'Fitness, budgeting', job: 'Hospitality learner', headline: 'Good food is a generous skill', bio: 'I can help with weeknight cooking, safe grilling, and recipes that do not need fancy equipment.', color: 'amber'},
    {name: 'Ahan Bhasin', username: 'ahan.bhasin', password: 'Relays!2026-Aha', hash: '7abc2b8b9013af45547f0a7cf2ade9bcd1e04d59837257e8e41d538dd3e6ae14', city: 'Hyderabad', teach: 'Motion design, After Effects, illustration', learn: 'Public speaking, project planning', job: 'Motion design learner', headline: 'Making movement explain an idea', bio: 'I share approachable motion design workflows and am always looking for clearer ways to present work.', color: 'purple'},
    {name: 'Ivaan Chawla', username: 'ivaan.chawla', password: 'Relays!2026-Iva', hash: 'bdb1b213e479942c2528e88be514426c057e14112ae60b5cefc804071efd31dd', city: 'Chandigarh', teach: 'Fitness, running, habit building', learn: 'Nutrition, guitar', job: 'Student coach', headline: 'Progress that fits real life', bio: 'I care about sustainable routines, beginner-friendly movement, and encouraging people without pressure.', color: 'green'},
    {name: 'Aariz Qureshi', username: 'aariz.qureshi', password: 'Relays!2026-Ari', hash: 'cfc3a065b440525041263cd42e22612f7ea9bc1ac8aad540d33df5772911a232', city: 'Lucknow', teach: 'Creative writing, Urdu poetry, editing', learn: 'Web development, entrepreneurship', job: 'Writer and editor', headline: 'Words that make room for people', bio: 'I enjoy collaborative editing, poetry, and helping early writers find a voice that sounds like them.', color: 'rose'},
    {name: 'Vardaan Puri', username: 'vardaan.puri', password: 'Relays!2026-Var', hash: 'b89a0e7aabaec1dbf79ac34b14607e21a9e7fcd61d707a6549728dc5ae7596d2', city: 'Ahmedabad', teach: 'Digital marketing, SEO, copywriting', learn: 'Photography, finance', job: 'Marketing learner', headline: 'Useful words, measurable work', bio: 'I help small projects understand content and search without turning everything into jargon.', color: 'teal'},
    {name: 'Ishita Talwar', username: 'ishita.talwar', password: 'Relays!2026-Ish', hash: 'd480c55fe5222dbeddc579145a7fbeff7cb85b69b61c52d3edc5b80ee04149b1', city: 'Chennai', teach: 'Tamil conversation, research, note-taking', learn: 'Public speaking, Python', job: 'Research student', headline: 'Learning out loud, one note at a time', bio: 'I love language exchange and can help people create a simple study system that actually gets used.', color: 'indigo'},
    {name: 'Aaradhya Wadhwa', username: 'aaradhya.wadhwa', password: 'Relays!2026-Aad', hash: 'ffa93df12006d5499cccb12396a60319c5a7b6713b2b2900cc4c2a7f8238de2d', city: 'Gurugram', teach: 'Career planning, interview practice, LinkedIn', learn: 'Graphic design, baking', job: 'Early career mentor', headline: 'Turning uncertainty into a next step', bio: 'I help students prepare for interviews and make a practical plan without pretending the path is linear.', color: 'peach'},
    {name: 'Vamika Anand', username: 'vamika.anand', password: 'Relays!2026-Vam', hash: '3cbb2dd14ea4fce2a498a6ebe423f8476a7c1283a377afa31e2dd496c9f289a7', city: 'Kochi', teach: 'Baking, food styling, Malayalam conversation', learn: 'Branding, illustration', job: 'Creative maker', headline: 'Warm skills for curious kitchens', bio: 'I teach approachable baking and love exchanging ideas about visual identity and creative work.', color: 'yellow'},
    {name: 'Inaya Bedi', username: 'inaya.bedi', password: 'Relays!2026-Ina', hash: 'b8f5faec2cd6268c2d8a985641e951cd25401a1c2e5aa9186888bbc508b687e5', city: 'Indore', teach: 'Yoga, mindfulness, journaling', learn: 'Frontend development, Spanish', job: 'Wellness facilitator', headline: 'Making space to notice what matters', bio: 'I share gentle mindfulness practices and want to understand how thoughtful digital products are built.', color: 'sage'},
    {name: 'Aarna Kohli', username: 'aarna.kohli', password: 'Relays!2026-Aan', hash: 'e0908f89248bc263c6c815b01b7b96c12c6c6bd0588aeffaf1924665596124b5', city: 'Noida', teach: 'Spanish conversation, presentation design, Canva', learn: 'Backend development, financial literacy', job: 'Presentation designer', headline: 'Helping ideas land with confidence', bio: 'I enjoy language practice, clean decks, and making complicated topics easier to share.', color: 'lavender'}
  ];

  const users = accountData.map((entry, index) => {
    const parts = entry.name.split(' ');
    const age = 19 + (index % 9);
    const dobYear = 2026 - age;
    return {
      id: id('user', index + 1),
      username: entry.username,
      email: entry.username + '@relayskills.demo',
      password_hash: entry.hash,
      role: 'member',
      status: 'active',
      verified: true,
      time_credits: 200 + index * 5,
      reward_points: 40 + index * 7,
      profile: {
        first_name: parts[0],
        last_name: parts.slice(1).join(' '),
        display_name: entry.name,
        phone_number: '+91 90000 ' + String(10001 + index),
        pronouns: '',
        gender: '',
        date_of_birth: dobYear + '-07-' + String(10 + index).padStart(2, '0'),
        age: String(age),
        country: 'India',
        city: entry.city,
        timezone: 'Asia/Kolkata',
        primary_language: 'English',
        additional_languages: 'Hindi',
        languages_to_learn: entry.learn,
        occupation: entry.job,
        professional_role: entry.job,
        organization: '',
        headline: entry.headline,
        bio: entry.bio,
        website: '',
        availability: index % 2 ? 'Weekday evenings and Saturday mornings' : 'Weekday mornings and Sunday afternoons',
        preferred_format: 'Remote or local',
        teaching_style: index % 3 === 0 ? 'Conversational' : index % 3 === 1 ? 'Project-based' : 'Practice and feedback',
        experience_level: index % 4 === 0 ? 'Advanced' : 'Intermediate',
        learning_goal: 'Make steady progress in ' + list(entry.learn)[0] + ' through a practical exchange.',
        skills_to_teach: entry.teach,
        skills_to_learn: entry.learn,
        interests: 'Community learning, creative projects, useful conversations',
        profile_color: entry.color,
        avatar_url: ''
      },
      preferences: {
        match_visibility: true,
        show_location: true,
        email_notifications: true,
        weekly_digest: true,
        profile_visibility: 'public',
        theme: 'light',
        font_scale: 'default',
        content_density: 'comfortable',
        navigation_style: 'expanded',
        default_landing: 'dashboard',
        high_contrast: false,
        reduced_motion: false,
        link_underlines: false,
        focus_mode: false,
        show_ai_assistant: true,
        auto_play_testimonials: true
      },
      safety: {
        account_type: 'adult',
        guardian_consent_status: 'not_applicable',
        is_minor: false,
        minor_messaging: 'standard',
        innovation_access: 'standard'
      },
      created_at: stamp(2 + index, 8 + (index % 7))
    };
  });

  const member = user => {
    const profile = user.profile || {};
    const reputationSeed = user.id.charCodeAt(user.id.length - 1);
    return {
      id: user.id,
      username: user.username,
      role: user.role || 'member',
      status: user.status || 'active',
      verified: Boolean(user.verified),
      time_credits: Number(user.time_credits || 0),
      reward_points: Number(user.reward_points || 0),
      profile: Object.assign({}, profile),
      profile_color: profile.profile_color,
      display_name: profile.display_name || user.username,
      country: profile.country,
      skills_to_teach: list(profile.skills_to_teach),
      skills_to_learn: list(profile.skills_to_learn),
      reputation: {
        rating: Number((4.55 + (reputationSeed % 5) / 10).toFixed(1)),
        review_count: 6 + (reputationSeed % 18),
        completed_sessions: 3 + (reputationSeed % 12),
        reliability_known: true,
        reliability_score: 88 + (reputationSeed % 11)
      },
      availability: {label: profile.availability || 'Availability not set', available_now: false, next_overlap_at: null},
      can_view_full: true,
      swap_requests_available: true
    };
  };

  const conversations = [];
  const messages = [];
  let messageNumber = 1;
  const addMessage = (conversation, sender, body, when, read) => {
    messages.push({
      id: id('message', messageNumber++),
      conversation_id: conversation.id,
      sender_id: sender.id,
      body: body,
      read: read !== false,
      created_at: when
    });
    conversation.updated_at = when;
  };
  const addDirectConversation = (number, first, second, topic) => {
    const conversation = {
      id: id('conversation', number),
      kind: 'direct',
      title: '',
      member_ids: [first.id, second.id],
      created_at: stamp(5 + number % 8, 10 + number % 6),
      updated_at: stamp(5 + number % 8, 10 + number % 6)
    };
    conversations.push(conversation);
    addMessage(conversation, first, 'Hi ' + second.profile.first_name + '! I saw that you want to learn ' + topic + '. Want to compare goals and find a small first step?', stamp(5 + number % 8, 10 + number % 6), true);
    addMessage(conversation, second, 'That sounds great. I can share what I am practising and would love your perspective.', stamp(5 + number % 8, 11 + number % 6), true);
    addMessage(conversation, first, 'Let us keep it practical: one clear outcome, one hour, and a short follow-up note.', stamp(5 + number % 8, 12 + number % 6), number % 3 !== 0);
    addMessage(conversation, second, 'Agreed. I will bring a small example so we can work through it together.', stamp(5 + number % 8, 13 + number % 6), number % 4 !== 0);
  };

  for (let index = 0; index < users.length; index += 1) {
    addDirectConversation(index + 1, users[index], users[(index + 1) % users.length], list(accountData[(index + 1) % users.length].learn)[0]);
  }
  [
    [0, 5, 'grilling and meal planning'],
    [2, 8, 'creative writing'],
    [4, 10, 'Tamil conversation'],
    [6, 12, 'frontend development'],
    [7, 11, 'career planning'],
    [9, 13, 'mindfulness'],
    [1, 9, 'photography'],
    [3, 14, 'Spanish conversation'],
    [5, 7, 'fitness'],
    [8, 12, 'presentation design']
  ].forEach((pair, index) => addDirectConversation(20 + index, users[pair[0]], users[pair[1]], pair[2]));

  const groupDefinitions = [
    {title: 'Frontend Builders', category: 'Technology', description: 'A friendly practice room for interfaces, APIs, and small shipped experiments.', accent: 'blue', icon: 'bx-code-alt', members: [0, 1, 2, 6, 12]},
    {title: 'Creative Practice Room', category: 'Creative skills', description: 'Share drafts, recipes, music, photographs, and generous feedback.', accent: 'coral', icon: 'bx-palette', members: [3, 4, 8, 11, 14]},
    {title: 'Everyday Wellness', category: 'Health and habits', description: 'Low-pressure conversations about movement, food, focus, and routines.', accent: 'mint', icon: 'bx-heart', members: [5, 7, 10, 12, 13]},
    {title: 'Language Exchange Table', category: 'Languages', description: 'Short conversation prompts and patient practice across languages.', accent: 'lilac', icon: 'bx-conversation', members: [3, 8, 10, 12, 14]}
  ];
  const groups = [];
  groupDefinitions.forEach((definition, index) => {
    const conversation = {
      id: id('conversation-group', index + 1),
      kind: 'group',
      title: definition.title,
      member_ids: definition.members.map(memberIndex => users[memberIndex].id),
      created_at: stamp(8 + index, 16),
      updated_at: stamp(20 + index, 18)
    };
    const group = {
      id: id('group', index + 1),
      title: definition.title,
      category: definition.category,
      description: definition.description,
      accent: definition.accent,
      icon: definition.icon,
      visibility: 'public',
      requires_approval: false,
      owner_id: users[definition.members[0]].id,
      moderator_ids: [users[definition.members[0]].id],
      member_ids: conversation.member_ids,
      conversation_id: conversation.id,
      pinned_messages: [{body: 'Keep questions specific, kind, and useful for the next person.', created_at: stamp(12 + index, 12)}],
      pending_join_requests: [],
      created_at: stamp(8 + index, 15)
    };
    conversations.push(conversation);
    groups.push(group);
    definition.members.forEach((memberIndex, messageIndex) => {
      addMessage(conversation, users[memberIndex], messageIndex === 0 ? 'Welcome to ' + definition.title + '! What would you like to practise this week?' : 'I can share a small example for the group to try.', stamp(12 + index, 12 + messageIndex), messageIndex % 3 !== 0);
    });
  });

  const events = [];
  const workshops = [];
  const workshopTopics = [
    ['Ship a calm landing page', 'Frontend development'],
    ['Build your first Node API', 'Backend development'],
    ['Python for curious beginners', 'Data and Python'],
    ['Guitar without the pressure', 'Music'],
    ['See more in your photographs', 'Photography'],
    ['Grill night: flavour and timing', 'Cooking'],
    ['Animate an idea in After Effects', 'Motion design'],
    ['A sustainable running routine', 'Fitness and wellbeing']
  ];
  workshopTopics.forEach((topic, index) => {
    const host = users[index];
    const registrationIndexes = [1, 2, 4, 6, 9, 12].map(offset => (index + offset) % users.length).filter(candidateIndex => candidateIndex !== index);
    const starts = future(1 + index * 2, 10 + (index % 5));
    const event = {
      id: id('event', index + 1),
      title: topic[0],
      description: 'A focused, friendly workshop hosted by ' + displayName(host) + ' with one practical outcome to take away.',
      starts_at: starts,
      ends_at: new Date(new Date(starts).getTime() + 90 * 60000).toISOString(),
      timezone: 'Asia/Kolkata',
      host_id: host.id,
      participant_ids: registrationIndexes.map(candidateIndex => users[candidateIndex].id),
      status: 'scheduled',
      location: index % 2 ? 'Online room' : 'Community studio · ' + host.profile.city,
      meeting_url: 'video-room.html?event=' + encodeURIComponent(id('event', index + 1)),
      reminders_minutes: [1440, 60],
      all_day: false
    };
    const workshop = {
      id: id('workshop', index + 1),
      event_id: event.id,
      host_id: host.id,
      title: topic[0],
      description: event.description,
      category: topic[1],
      level: index % 3 === 0 ? 'Beginner friendly' : 'All levels',
      format: index % 2 ? 'Online' : 'Hybrid',
      location: event.location,
      timezone: 'Asia/Kolkata',
      starts_at: starts,
      duration_minutes: 90,
      seat_limit: 16,
      status: 'scheduled',
      registered_user_ids: registrationIndexes.map(candidateIndex => users[candidateIndex].id),
      outcomes: ['Leave with one finished example', 'Know the next useful practice step'],
      tags: [topic[1], 'peer learning', 'demo community']
    };
    events.push(event);
    workshops.push(workshop);
  });
  [
    [0, 2, 'Portfolio feedback exchange'],
    [6, 10, 'Practice presentation and confidence'],
    [11, 13, 'Branding sketch session']
  ].forEach((session, index) => {
    const starts = stamp(16 + index, 14);
    events.push({
      id: id('event-completed', index + 1),
      title: session[2],
      description: 'A completed demo exchange recorded between two members.',
      starts_at: starts,
      ends_at: new Date(new Date(starts).getTime() + 60 * 60000).toISOString(),
      timezone: 'Asia/Kolkata',
      host_id: users[session[0]].id,
      participant_ids: [users[session[0]].id, users[session[1]].id],
      status: 'completed',
      location: 'Online room',
      meeting_url: '',
      reminders_minutes: [60],
      all_day: false
    });
  });

  const posts = users.map((user, index) => ({
    id: id('post', index + 1),
    author: member(user),
    author_id: user.id,
    body: [
      'Today I turned a vague idea into a small, testable first step.',
      'Sharing a tiny practice note: explain the concept with an example before adding jargon.',
      'Looking for a partner to compare learning routines and keep each other accountable.',
      'A good exchange leaves both people with something they can use tomorrow.'
    ][index % 4],
    visibility: 'public',
    media: null,
    counts: {likes: 3 + index, comments: 1 + index % 5, shares: index % 3},
    viewer_liked: false,
    viewer_shared: false,
    created_at: stamp(14 + index % 7, 9 + index % 8)
  }));

  const stories = users.slice(0, 8).map((user, index) => ({
    id: id('story', index + 1),
    author: member(user),
    author_id: user.id,
    body: ['Practising one useful thing today.', 'Workshop prep is underway.', 'A small win from this week.', 'Open to a thoughtful skill exchange.'][index % 4],
    visibility: 'public',
    media: null,
    created_at: stamp(22, 8 + index),
    expires_at: new Date(Date.now() + 86400000).toISOString()
  }));

  const ideas = [
    ['Skill kits for first-time teachers', 'A lightweight collection of prompts that helps anyone prepare a clear first peer lesson.', 0, 'Community learning'],
    ['Neighbourhood practice walks', 'Pair a practical skill with a short public-space activity and a reflection afterwards.', 5, 'Wellbeing'],
    ['Open portfolio review evenings', 'A welcoming monthly room where members can bring unfinished work and ask one focused question.', 4, 'Creative skills'],
    ['Language confidence circles', 'Small groups practise real situations rather than memorising disconnected vocabulary.', 10, 'Languages'],
    ['One-hour build weekends', 'A gentle format for shipping one tiny project with a peer and documenting what changed.', 1, 'Technology']
  ].map((idea, index) => ({
    id: id('idea', index + 1),
    title: idea[0],
    summary: idea[1],
    tagline: idea[1],
    category: idea[3],
    stage: index % 2 ? 'pilot' : 'seeking_support',
    problem: 'People often need a smaller, safer starting point before committing to a long course.',
    solution: idea[1],
    beneficiaries: 'Students, career changers, and community members',
    impact: 'More useful first exchanges and clearer next steps.',
    funding_currency: 'time credits',
    funding_needed: 20 + index * 10,
    funds_use: 'Facilitation, accessibility, and community documentation.',
    skills_needed: list(accountData[index].teach),
    collaboration: 'Hosts, reviewers, and curious members',
    reach: 'Local communities and remote learners',
    prototype_url: '',
    pitch: idea[1],
    status: 'published',
    owner: member(users[idea[2]]),
    owner_id: users[idea[2]].id,
    owner_age_group: 'adult',
    safety_review_status: 'not required',
    guardian_consent_status: 'not required',
    specialist_reviewer_id: '',
    created_at: stamp(10 + index, 11),
    like_count: 4 + index,
    save_count: 2 + index,
    comment_count: 1 + index,
    comments: [],
    pledges: [],
    moderation_notes: ''
  }));

  const feedbackQuotes = [
    'The exchange stayed focused and kind. I left with a working first draft instead of a pile of notes.',
    'I finally understood the backend flow because Eshan explained it with a tiny project and checked my questions.',
    'The workshop gave me a simple practice routine I could actually repeat during the week.',
    'Aariz asked thoughtful questions and made editing feel collaborative rather than intimidating.',
    'The best part was how reciprocal it felt: I learned something and still had something useful to offer.',
    'The session was organised, warm, and specific. We both knew what success looked like before starting.',
    'I joined for one conversation and found a small circle of people who keep showing up for each other.',
    'This is the first time a learning platform has made the next step feel human-sized.'
  ];
  const feedback = users.map((user, index) => {
    const partner = users[(index + 3) % users.length];
    return {
      id: id('feedback', index + 1),
      name: displayName(user),
      email: user.email,
      role: user.profile.professional_role + ' · exchange with ' + displayName(partner),
      rating: 4 + (index % 2),
      title: ['A practical first step', 'Clear, kind, and genuinely useful', 'Learning that moves both ways', 'A great reason to keep practising'][index % 4],
      message: feedbackQuotes[index % feedbackQuotes.length],
      permission_to_publish: true,
      publication_permission: true,
      featured: index < 6,
      status: 'published',
      author_id: user.id,
      created_at: stamp(18 + index % 5, 15 + index % 4)
    };
  });

  const journals = users.map((user, index) => ({
    id: id('journal', index + 1),
    user_id: user.id,
    title: 'After my ' + (index % 2 ? 'workshop' : 'exchange'),
    skill: list(accountData[index].learn)[0],
    minutes: 35 + index * 5,
    confidence: 3 + (index % 3),
    mood: ['curious', 'energised', 'grounded'][index % 3],
    visibility: 'private',
    reflection: 'I learned that a smaller goal made it easier to ask for help and notice progress.',
    next_step: 'Repeat the practice once before the next conversation.',
    created_at: stamp(19 + index % 4, 17)
  }));

  const portfolios = {};
  users.forEach((user, index) => {
    portfolios[user.id] = {
      title: displayName(user) + "'s learning portfolio",
      headline: user.profile.headline,
      intro: 'A small collection of practical work, exchange notes, and next steps.',
      visibility: 'public',
      accent: user.profile.profile_color,
      links: [],
      show_completed_jobs: true,
      show_journal: true,
      show_ideas: index % 2 === 0,
      show_workshops: true,
      projects: [{
        id: id('project', index + 1),
        title: index % 2 ? 'Workshop notes and takeaways' : 'A useful first prototype',
        description: 'A demo portfolio item created from a completed peer-learning activity.',
        status: 'in progress',
        skills: list(accountData[index].teach).slice(0, 2),
        created_at: stamp(13 + index % 5, 13)
      }]
    };
  });

  const livestreams = [0, 3, 6, 10].map((userIndex, index) => ({
    id: id('livestream', index + 1),
    host_id: users[userIndex].id,
    title: ['Live UI teardown and redesign', 'Acoustic guitar practice room', 'Animate one idea in 45 minutes', 'Research notes co-working room'][index],
    description: 'A scheduled demo broadcast with time for questions and peer feedback.',
    category: ['Design', 'Music', 'Creative skills', 'Study'][index],
    tags: ['demo community', 'live practice', 'questions'],
    scheduled_at: future(2 + index, 17),
    status: index === 0 ? 'live' : 'scheduled',
    host: member(users[userIndex]),
    viewer_count: 4 + index * 3,
    credits_donated: index * 2
  }));

  const swapjobs = users.slice(0, 8).map((user, index) => ({
    id: id('swapjob', index + 1),
    owner_id: user.id,
    owner: member(user),
    title: ['Review my first landing page', 'Practise a short presentation', 'Plan a week of healthy meals', 'Help me edit a photo series', 'Pair on a small Python script', 'Trade guitar feedback for running tips', 'Test a language conversation prompt', 'Sketch a simple brand direction'][index],
    description: 'A small, well-scoped request for a patient peer exchange.',
    skills_needed: list(accountData[(index + 2) % users.length].teach).slice(0, 2),
    status: 'open',
    proposal_count: 2 + index,
    created_at: stamp(20 + index % 3, 10)
  }));

  const ledger = [];
  for (let index = 0; index < 10; index += 1) {
    const payer = users[index];
    const recipient = users[(index + 1) % users.length];
    const amount = 2 + (index % 4);
    payer.time_credits -= amount;
    recipient.time_credits += amount;
    const reference = id('payment', index + 1);
    ledger.push({
      id: id('ledger-debit', index + 1),
      user_id: payer.id,
      type: 'payment',
      amount: -amount,
      balance_after: payer.time_credits,
      description: 'Demo exchange with ' + displayName(recipient),
      counterparty: member(recipient),
      reference_id: reference,
      reference_type: 'credit_transfer',
      created_by: payer.id,
      created_at: stamp(21 + index % 2, 18)
    });
    ledger.push({
      id: id('ledger-credit', index + 1),
      user_id: recipient.id,
      type: 'payment',
      amount: amount,
      balance_after: recipient.time_credits,
      description: 'Demo exchange with ' + displayName(payer),
      counterparty: member(payer),
      reference_id: reference,
      reference_type: 'credit_transfer',
      created_by: payer.id,
      created_at: stamp(21 + index % 2, 18)
    });
  }

  const notifications = [];
  users.forEach((user, index) => {
    notifications.push({id: id('notification', index * 3 + 1), user_id: user.id, type: 'workshop_invite', message: 'You have a place in a demo community workshop.', entity_id: workshops[index % workshops.length].id, read: index % 3 === 0, created_at: stamp(22, 9 + index % 6)});
    notifications.push({id: id('notification', index * 3 + 2), user_id: user.id, type: 'message', message: displayName(users[(index + 1) % users.length]) + ' sent you a thoughtful exchange message.', entity_id: conversations[index].id, read: false, created_at: stamp(22, 12 + index % 5)});
    notifications.push({id: id('notification', index * 3 + 3), user_id: user.id, type: 'feedback', message: 'A published testimonial now includes your recent exchange.', entity_id: feedback[index].id, read: index % 2 === 0, created_at: stamp(22, 16 + index % 4)});
  });

  const follows = [];
  for (let index = 0; index < users.length; index += 1) {
    follows.push({id: id('follow', index + 1), follower_id: users[index].id, following_id: users[(index + 2) % users.length].id, created_at: stamp(11 + index % 4, 10)});
    follows.push({id: id('follow', index + 16), follower_id: users[index].id, following_id: users[(index + 5) % users.length].id, created_at: stamp(12 + index % 4, 10)});
  }

  const vouchers = [0, 4, 8, 12].map((userIndex, index) => ({
    id: id('voucher', index + 1),
    creator_id: users[userIndex].id,
    amount: 5 + index * 2,
    status: 'active',
    code_preview: 'SA-DEMO-' + String(index + 1).padStart(2, '0') + '-••••',
    code: 'SA-DEMO-' + String(index + 1).padStart(2, '0') + '-RELAYS'
  }));

  const seededUserIds = new Set(users.map(user => user.id));
  const removeSeeded = value => Array.isArray(value) ? value.filter(item => !String(item && item.id || '').startsWith('demo15-')) : value;
  store.users = (store.users || []).filter(user => !seededUserIds.has(user.id));
  store.users.push(...users);
  store.notifications = removeSeeded(store.notifications);
  store.conversations = removeSeeded(store.conversations);
  store.messages = removeSeeded(store.messages);
  store.events = removeSeeded(store.events);
  store.workshops = removeSeeded(store.workshops);
  store.posts = removeSeeded(store.posts);
  store.stories = removeSeeded(store.stories);
  store.groups = removeSeeded(store.groups);
  store.ideas = removeSeeded(store.ideas);
  store.journals = removeSeeded(store.journals);
  store.ledger = removeSeeded(store.ledger);
  store.vouchers = removeSeeded(store.vouchers);
  store.livestreams = removeSeeded(store.livestreams);
  store.swapjobs = removeSeeded(store.swapjobs);
  store.follows = removeSeeded(store.follows);
  store.feedback = removeSeeded(store.feedback);
  store.notifications.push(...notifications);
  store.conversations.push(...conversations);
  store.messages.push(...messages);
  store.events.push(...events);
  store.workshops.push(...workshops);
  store.posts.unshift(...posts);
  store.stories.unshift(...stories);
  store.groups.push(...groups);
  store.ideas.unshift(...ideas);
  store.journals.unshift(...journals);
  store.ledger.push(...ledger);
  store.vouchers.push(...vouchers);
  store.livestreams.push(...livestreams);
  store.swapjobs.unshift(...swapjobs);
  store.follows.push(...follows);
  store.feedback.unshift(...feedback);
  store.portfolios = Object.assign({}, store.portfolios || {}, portfolios);
  store.achievements = Object.assign({}, store.achievements || {});
  users.forEach((user, index) => {
    store.achievements[user.id] = index % 3 === 0 ? ['profile-starter', 'curious-teacher', 'learning-direction'] : ['profile-starter', 'curious-teacher'];
    store.onboarding[user.id] = true;
  });
  store.adminMessages = removeSeeded(store.adminMessages || []).concat([
    {id: id('admin-message', 1), subject: 'Demo community seeded', body: 'Fifteen local demo accounts and connected activity are ready for review.', status: 'sent', created_at: stamp(22, 18)},
    {id: id('admin-message', 2), subject: 'Workshop activity sample', body: 'The demo group includes workshops, scheduled sessions, and completed exchange history.', status: 'sent', created_at: stamp(22, 18)}
  ]);
  store.demoCommunitySeedVersion = seedVersion;
  store.demoCommunitySeedSummary = {
    accounts: users.length,
    conversations: conversations.length,
    messages: messages.length,
    workshops: workshops.length,
    events: events.length,
    groups: groups.length,
    posts: posts.length,
    testimonials: feedback.length,
    seeded_at: new Date().toISOString()
  };

  try {
    window.localStorage.setItem(storeKey, JSON.stringify(store));
    window.dispatchEvent(new CustomEvent('SwapLabs:demo-community-seeded', {detail: store.demoCommunitySeedSummary}));
  } catch (error) {
    console.error('Could not save the local demo community seed.', error);
  }
})();
