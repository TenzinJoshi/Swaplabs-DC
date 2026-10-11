/*
 * Local-only blog community seed.
 *
 * The seed uses the member accounts already present in the browser store. It
 * creates seven clearly labelled platform stories, each with a different
 * member as author and conversation from other members. It never creates a
 * separate account or sends anything to a hosted service.
 */
(() => {
  'use strict';

  const localHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);
  if (!localHosts.has(window.location.hostname)) return;

  const storeKey = 'relayskills-local-demo-v1';
  const seedVersion = 'relayskills-platform-blogs-v1';
  const read = () => {
    try { return JSON.parse(window.localStorage.getItem(storeKey) || 'null') || {}; }
    catch (_error) { return {}; }
  };
  const saved = read();
  if (saved.demoBlogSeedVersion === seedVersion) return;

  const members = (Array.isArray(saved.users) ? saved.users : [])
    .filter(user => user && user.role !== 'admin' && user.status !== 'suspended');
  if (members.length < 7) return;

  const stamp = daysAgo => new Date(Date.now() - daysAgo * 86400000).toISOString();
  const id = (prefix, number) => `seed-blog-${prefix}-${String(number).padStart(2, '0')}`;
  const stories = [
    {
      title: 'Why equal time makes learning feel possible',
      excerpt: 'A fair exchange starts by valuing the hour someone gives, not the price tag attached to the skill.',
      body: 'The idea behind SwapLabs is simple: every person has something useful to share, and every hour deserves equal respect.\n\nWhen money is removed from the first conversation, people can focus on the real question: what would make the next hour genuinely useful for both of us? That shift makes learning feel more human and gives students a practical way to contribute before they feel like experts.',
      tags: ['Time credits', 'Community', 'Learning'],
      media: [{type: 'image/png', name: 'Knowledge in motion', url: '/assets/home-reference-community.jpg'}]
    },
    {
      title: 'My first exchange started with one small question',
      excerpt: 'The best matches do not begin with a perfect plan. They begin with enough curiosity to ask for help.',
      body: 'A first exchange can feel intimidating when you think you need a complete curriculum, a polished portfolio, or a five-year goal. You do not.\n\nPick one outcome you can describe in a sentence. Share what you already know, name the part that feels stuck, and let the other person bring their perspective. A small, specific question is often the fastest way to find a generous collaborator.',
      tags: ['First exchange', 'Confidence', 'Students']
    },
    {
      title: 'What makes a profile useful to another learner',
      excerpt: 'A useful profile is less about sounding impressive and more about making the next conversation easier to start.',
      body: 'The strongest member profiles on SwapLabs make three things clear: what the person can teach, what they want to learn, and what kind of exchange feels comfortable.\n\nSpecific beats impressive. “I can review a beginner Figma flow” gives someone a much clearer opening than “I know design.” Add a little context, keep your expectations honest, and leave room for the other person to shape the session with you.',
      tags: ['Profiles', 'Trust', 'Matching'],
      media: [{type: 'image/png', name: 'Community members', url: '/assets/home-reference-avatars.jpg'}]
    },
    {
      title: 'Building a calmer way to find collaborators',
      excerpt: 'Discovery is only useful when it leads to a safe, practical next step.',
      body: 'A directory can show you thousands of possibilities and still leave you unsure what to do next. SwapLabs is designed around the step after discovery: a clear request, a respectful message, and a shared outcome.\n\nThat is why matching looks at more than a keyword. Timezone, format, language, experience, availability, and the shape of the learning goal all matter when two people are deciding whether an hour together will work.',
      tags: ['Matching', 'Safety', 'Product design']
    },
    {
      title: 'Lessons from designing SwapLabs for students',
      excerpt: 'Student builders need room to experiment, but they also need tools that make everyday progress visible.',
      body: 'Building for students means respecting limited time, uneven confidence, and the fact that learning rarely follows a straight line. The platform has to make small progress count without turning every contribution into a performance.\n\nThat principle shapes the product: gentle onboarding, transparent time credits, public and private choices, and places to save the work that proves a new skill is becoming real.',
      tags: ['Building SwapLabs', 'Student builders', 'Design'],
      media: [{type: 'image/png', name: 'Mountain of progress', url: '/assets/home-reference-mountains.jpg'}]
    },
    {
      title: 'The underrated skill of teaching what you just learned',
      excerpt: 'You do not need to know everything before you can help someone take their next step.',
      body: 'Teaching is not only a stage reserved for experts. Sometimes the most useful person in the room is the learner who remembers exactly where the confusing part was yesterday.\n\nExplain the first principle, show a tiny example, ask what still feels unclear, and be honest about what you are still working through. That is not a lesser kind of teaching. It is a practical form of peer support, and it keeps knowledge moving in both directions.',
      tags: ['Teaching', 'Peer learning', 'Practice']
    },
    {
      title: 'A week of small progress in the SwapLabs community',
      excerpt: 'One message, one focused session, and one honest reflection can change the shape of a week.',
      body: 'Community is built from repeatable actions rather than grand announcements. Someone replies to a beginner question. Someone shares a draft before it feels finished. Two people protect an hour for a real exchange, then record what they learned.\n\nThose moments are the platform: ordinary, specific, and generous. If you have been waiting for the right time to join in, start with one useful thing you can offer or one question you would be glad to explore with another member.',
      tags: ['Community notes', 'Progress', 'Getting started']
    }
  ];

  const blogs = stories.map((story, index) => {
    const author = members[index];
    const likes = members.filter(member => member.id !== author.id).slice(index % 3, 3 + (index % 3));
    return {
      id: id('post', index + 1), author_id: author.id, title: story.title, excerpt: story.excerpt, body: story.body,
      tags: story.tags, visibility: 'public', media: story.media || [], like_user_ids: likes.map(member => member.id),
      share_user_ids: [], counts: {likes: likes.length, comments: 2, shares: 0}, status: 'published',
      created_at: stamp(index + 1), updated_at: stamp(index + 1)
    };
  });

  const comments = blogs.flatMap((post, index) => {
    const first = members[(index + 1) % members.length];
    const second = members[(index + 2) % members.length];
    return [
      {id: id(`comment-${index + 1}`, 1), blog_id: post.id, author_id: first.id, body: ['This is exactly the kind of practical context I look for here.', 'I like the reminder that a first step can stay small and still matter.', 'The profile advice makes it much easier to imagine starting a conversation.'][index % 3], created_at: stamp(index + 1) },
      {id: id(`comment-${index + 1}`, 2), blog_id: post.id, author_id: second.id, body: ['I am taking this into my next exchange. Clear, kind, and useful.', 'The part about equal respect for an hour really stayed with me.', 'A thoughtful post — sharing this with our practice group.'][index % 3], created_at: stamp(index + 1) }
    ];
  });

  saved.blogs = (Array.isArray(saved.blogs) ? saved.blogs : []).filter(post => !String(post?.id || '').startsWith('seed-blog-')).concat(blogs);
  saved.blog_comments = (Array.isArray(saved.blog_comments) ? saved.blog_comments : []).filter(comment => !String(comment?.id || '').startsWith('seed-blog-')).concat(comments);
  saved.demoBlogSeedVersion = seedVersion;
  try {
    window.localStorage.setItem(storeKey, JSON.stringify(saved));
    window.dispatchEvent(new CustomEvent('SwapLabs:blog-seeded', {detail: {posts: blogs.length, comments: comments.length}}));
  } catch (_error) { /* A blocked local store simply leaves the page empty. */ }
})();
