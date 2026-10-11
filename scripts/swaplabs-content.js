/* Live summaries replace the former fabricated page-expansion statistics. */
(() => {
  const current = location.pathname.split('/').pop();
  const community = ['forums.html','groups.html','community-challenges.html','mentors.html','success-stories.html'].includes(current);
  const learning = ['courses.html','resources.html','learning-paths.html','events.html'].includes(current);
  const metrics = community ? [['active_members','registered active member accounts'],['public_groups','public community groups'],['private_group_chats','private group chats (count only)'],['public_ideas','published ideas'],['public_testimonials','public feedback entries']]
    : learning ? [['skills','publicly listed skills'],['upcoming_workshops','upcoming workshops'],['completed_sessions','confirmed completed sessions'],['hours_exchanged','scheduled hours of confirmed sessions']]
    : [['active_members','registered active accounts'],['skills','publicly listed skills'],['countries','countries represented'],['all_interactions','calls, sessions & meetings recorded']];
  document.querySelector('[data-site-footer]')?.insertAdjacentHTML('beforebegin', '<section class="expansion-stats"><div class="container expansion-stat-grid">'+metrics.map(([key,label])=>'<div class="expansion-stat"><strong data-platform-metric="'+key+'">—</strong><span>'+label+'</span></div>').join('')+'</div><p class="container live-data-status" data-live-status role="status">Loading recorded platform totals…</p></section>');
  window.SwapLabsMetrics?.refresh();
})();
