/*
 * Local-only demo submissions fixture.
 *
 * This gives the protected administration preview a useful queue to review
 * without pretending that these records came from real people. It only runs
 * on the local admin entry point and stores records in the browser's demo
 * store; production data is never touched.
 */
(() => {
  'use strict';

  const localHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);
  if (!localHosts.has(window.location.hostname) || !/\/admin\.html$/i.test(window.location.pathname)) return;

  const storeKey = 'relayskills-local-demo-v1';
  const seedVersion = 'relayskills-demo-submissions-v1';
  let store;
  try {
    store = JSON.parse(window.localStorage.getItem(storeKey) || 'null');
  } catch (_error) {
    store = null;
  }
  if (!store || store.demoSubmissionSeedVersion === seedVersion) return;

  store = {...store};
  const stamp = (day, hour) => new Date(Date.UTC(2026, 8, day, hour || 10, 0, 0)).toISOString();
  const id = (kind, number) => `demo-submission-${kind}-${String(number).padStart(2, '0')}`;
  const registrationId = number => `demo-registration-${String(number).padStart(2, '0')}`;
  const users = (Array.isArray(store.users) ? store.users : []).filter(item => item?.role !== 'admin' && item?.status !== 'suspended');
  const memberAt = index => users.length ? users[index % users.length] : null;
  const memberName = user => user?.profile?.display_name || user?.username || 'Demo member';
  const memberEmail = user => user?.email || `${user?.username || 'member'}@relayskills.demo`;
  const removeSeeded = value => Array.isArray(value) ? value.filter(item => {
    const itemId = String(item?.id || '');
    return !itemId.startsWith('demo-submission-') && !itemId.startsWith('demo-registration-');
  }) : [];

  const contactTemplates = [
    ['Account access', 'I cannot see my workshop registration after switching devices.', 'new', 'Email'],
    ['Workshops and events', 'Can the next frontend practice room include a short portfolio review?', 'reviewing', 'Email'],
    ['Accessibility', 'The community cards need stronger keyboard focus while I browse on a laptop.', 'new', 'Email'],
    ['Skill match or member experience', 'I found a great match and would like to understand how equal time is recorded.', 'replied', 'Email'],
    ['Company or community partnership', 'Our student club would like to host a monthly exchange circle.', 'reviewing', 'Video call requested'],
    ['Privacy request', 'Please explain which profile details are visible in the member directory.', 'closed', 'Email'],
    ['Time credits or billing', 'A completed exchange appears to be missing from my credit ledger.', 'new', 'Phone call requested'],
    ['General question', 'Is there a way to save a workshop and return to it later?', 'replied', 'Email'],
    ['Press and media', 'We are writing about student-led learning communities and would like a short briefing.', 'new', 'Email'],
    ['School or education program', 'Can teachers create a private practice group for their class?', 'reviewing', 'Email']
  ];
  const contacts = contactTemplates.map((entry, index) => {
    const user = memberAt(index + 1);
    return {
      id: id('contact', index + 1),
      name: memberName(user),
      email: memberEmail(user),
      user_id: user?.id || '',
      topic: entry[0],
      preferred_contact: entry[3],
      subject: entry[1].split('.')[0],
      message: entry[1],
      status: entry[2],
      admin_notes: index % 3 === 0 ? 'Demo queue item — confirm the member context before replying.' : '',
      created_at: stamp(8 + index, 9 + index % 7)
    };
  });

  const complaintTemplates = [
    ['Account access or profile', 'Profile photo upload did not remain after saving.', 'standard', 'reviewing'],
    ['Workshop or live session delivery', 'A workshop started late and the promised practice time was shortened.', 'time-sensitive', 'received'],
    ['Accessibility barrier', 'The calendar controls were difficult to use with keyboard navigation.', 'time-sensitive', 'reviewing'],
    ['Time credits or billing', 'My completed exchange shows the wrong credit amount.', 'standard', 'received'],
    ['Skill match or member experience', 'A match invitation was sent after I paused my availability.', 'standard', 'resolved'],
    ['Privacy or data handling', 'I want an old public contribution hidden from my profile.', 'standard', 'closed'],
    ['Moderation decision', 'Please explain why my idea was moved to specialist review.', 'urgent', 'reviewing'],
    ['Customer support experience', 'My original support request was closed before I received an answer.', 'time-sensitive', 'received']
  ];
  const complaints = complaintTemplates.map((entry, index) => {
    const user = memberAt(index + 3);
    return {
      id: id('complaint', index + 1),
      name: memberName(user),
      email: memberEmail(user),
      user_id: user?.id || '',
      category: entry[0],
      priority: entry[2],
      subject: entry[1],
      reference: index % 2 === 0 ? `demo-case-${String(index + 1).padStart(3, '0')}` : '',
      details: `${entry[1]} This is a local demonstration record with enough context for an administrator to practise triage, notes, and status changes.`,
      resolution: index % 2 === 0 ? 'Please correct the record and confirm the next step.' : 'Please explain the decision and provide a practical route forward.',
      status: entry[3],
      admin_notes: entry[3] === 'resolved' || entry[3] === 'closed' ? 'Demo record resolved after follow-up.' : 'Demo queue item — review the account history and respond with a clear owner.',
      created_at: stamp(9 + index, 10 + index % 6)
    };
  });

  const feedbackTemplates = [
    ['A calmer way to practise', 'The exchange helped me break a large goal into one useful hour.', 'Student and frontend learner', 5, true, 'published'],
    ['The right kind of accountability', 'A small check-in with another learner made me return to my practice.', 'Creative maker', 4, true, 'published'],
    ['Helpful without feeling formal', 'The community conversation felt warm, specific, and easy to join.', 'Workshop participant', 5, true, 'reviewing'],
    ['Great first match', 'I traded photography feedback for help planning a simple portfolio.', 'Visual storyteller', 5, true, 'published'],
    ['A practical learning loop', 'The best part was leaving with a small next step rather than a long list of notes.', 'Computer science student', 4, true, 'published'],
    ['Please add more time zones', 'I enjoyed the platform, but finding a shared evening slot took some effort.', 'Language learner', 4, false, 'private'],
    ['Clearer group notifications would help', 'I missed one reply because the conversation badge was easy to overlook.', 'Community member', 3, false, 'private'],
    ['Useful and human', 'I learned something concrete and met someone who explained it patiently.', 'Independent musician', 5, true, 'published'],
    ['Good space for beginners', 'The tone made it comfortable to ask a question without pretending I already knew the answer.', 'Early career mentor', 5, true, 'reviewing'],
    ['Keep the simple structure', 'The focused exchange format is more useful to me than an endless course library.', 'Data enthusiast', 4, true, 'published']
  ];
  const feedback = feedbackTemplates.map((entry, index) => {
    const user = memberAt(index + 5);
    return {
      id: id('feedback', index + 1),
      author_id: user?.id || '',
      name: memberName(user),
      email: memberEmail(user),
      role: entry[2],
      rating: entry[3],
      title: entry[0],
      message: entry[1],
      permission_to_publish: entry[4],
      publication_permission: entry[4],
      featured: index === 0 || index === 7,
      status: entry[5],
      admin_notes: entry[4] ? '' : 'Private demo feedback — do not publish without explicit permission.',
      created_at: stamp(10 + index, 11 + index % 6)
    };
  });

  const workshops = Array.isArray(store.workshops) ? store.workshops : [];
  const registrations = [];
  let registrationNumber = 1;
  workshops.slice(0, 6).forEach((workshop, workshopIndex) => {
    workshop.registered_user_ids = Array.isArray(workshop.registered_user_ids) ? [...workshop.registered_user_ids] : [];
    const candidates = users.filter(user => user.id !== workshop.host_id);
    [0, 2, 4].forEach((offset, placeIndex) => {
      const user = candidates[(workshopIndex + offset) % Math.max(1, candidates.length)];
      if (!user) return;
      const status = placeIndex === 2 && workshopIndex % 2 === 0 ? 'attended' : placeIndex === 1 && workshopIndex === 3 ? 'cancelled' : 'registered';
      if (status === 'registered' && !workshop.registered_user_ids.includes(user.id)) workshop.registered_user_ids.push(user.id);
      registrations.push({
        id: registrationId(registrationNumber++),
        workshop_id: workshop.id,
        user_id: user.id,
        status,
        admin_notes: status === 'attended' ? 'Demo attendance confirmed.' : '',
        created_at: stamp(12 + workshopIndex, 13 + placeIndex)
      });
    });
  });

  store.contact_messages = removeSeeded(store.contact_messages);
  store.complaints = removeSeeded(store.complaints);
  store.feedback = removeSeeded(store.feedback);
  store.workshop_registrations = removeSeeded(store.workshop_registrations);
  store.contact_messages.push(...contacts);
  store.complaints.push(...complaints);
  store.feedback.push(...feedback);
  store.workshop_registrations.push(...registrations);
  store.demoSubmissionSeedVersion = seedVersion;
  store.demoSubmissionSeedSummary = {
    contacts: contacts.length,
    complaints: complaints.length,
    feedback: feedback.length,
    registrations: registrations.length,
    seeded_at: new Date().toISOString()
  };

  try {
    window.localStorage.setItem(storeKey, JSON.stringify(store));
    window.dispatchEvent(new CustomEvent('SwapLabs:demo-submissions-seeded', {detail: store.demoSubmissionSeedSummary}));
  } catch (error) {
    console.error('Could not save the local demo submission seed.', error);
  }
})();
