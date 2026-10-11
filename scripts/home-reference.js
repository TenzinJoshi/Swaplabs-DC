(() => {
  const isHomepage = document.body?.classList.contains('home-simple');
  if (!isHomepage) return;

  const list = value => (Array.isArray(value) ? value : String(value || '').split(',')).map(item => String(item || '').trim()).filter(item => item && item.toLowerCase() !== 'nothing for now');
  const profileOf = member => member?.profile || member || {};
  const memberName = member => profileOf(member).display_name || member?.display_name || member?.username || 'SwapLabs member';
  const initials = value => memberName({profile: {display_name: value}}).split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || 'SM';
  const safeAvatar = value => /^(?:\/uploads\/usr_[A-Za-z0-9_-]+\.(?:jpg|png|webp)|data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2})$/.test(String(value || '')) ? String(value) : '';
  const iconFor = value => {
    const text = String(value || '').toLowerCase();
    if (/photo|photography|design|illustrat|visual|canva|figma/.test(text)) return 'bx-camera';
    if (/cook|baking|food|fitness|yoga|running|wellness/.test(text)) return 'bx-heart';
    if (/music|guitar|song|writing|language|spanish|hindi|tamil/.test(text)) return 'bx-message-rounded-dots';
    if (/code|python|backend|frontend|node|database|excel|data|seo/.test(text)) return 'bx-code-alt';
    return 'bx-bulb';
  };

  // Keep the hero useful on first paint and when the local member endpoint is
  // unavailable. These are the same member profiles used by the local demo
  // directory, presented here as a small static snapshot of the community.
  const staticHomepageMembers = [
    ['Aviraaj Oberoi', 'aviraaj.oberoi', 'Frontend development', 'Backend development', 5.0, 10],
    ['Eshan Dutta', 'eshan.dutta', 'Backend development', 'Product strategy', 4.6, 11],
    ['Aarush Kohli', 'aarush.kohli', 'Python and data analysis', 'Machine learning', 4.7, 12],
    ['Tavish Anand', 'tavish.anand', 'Guitar and music theory', 'Video editing', 4.8, 13],
    ['Ritvik Wadhwa', 'ritvik.wadhwa', 'Photography and Lightroom', 'UI design', 4.9, 14],
    ['Yug Bedi', 'yug.bedi', 'Indian cooking and meal prep', 'Fitness', 5.0, 15],
    ['Ahan Bhasin', 'ahan.bhasin', 'Motion design and illustration', 'Public speaking', 4.6, 16],
    ['Ivaan Chawla', 'ivaan.chawla', 'Fitness and running', 'Nutrition', 4.7, 17],
    ['Aariz Qureshi', 'aariz.qureshi', 'Creative writing and editing', 'Web development', 4.8, 18],
    ['Vardaan Puri', 'vardaan.puri', 'Digital marketing and SEO', 'Photography', 4.9, 18],
    ['Ishita Talwar', 'ishita.talwar', 'Tamil conversation and research', 'Public speaking', 5.0, 10],
    ['Aaradhya Wadhwa', 'aaradhya.wadhwa', 'Career planning and interview practice', 'Graphic design', 4.6, 11],
    ['Vamika Anand', 'vamika.anand', 'Baking and food styling', 'Branding', 4.7, 12],
    ['Inaya Bedi', 'inaya.bedi', 'Yoga and mindfulness', 'Frontend development', 4.8, 13],
    ['Aarna Kohli', 'aarna.kohli', 'Spanish conversation and Canva', 'Backend development', 4.9, 14]
  ].map(([name, username, teaches, learns, rating, reviews], index) => ({
    id: `demo15-user-${String(index + 1).padStart(2, '0')}`,
    username,
    role: 'member',
    status: 'active',
    visibility: 'public',
    profile: {display_name: name, skills_to_teach: [teaches], skills_to_learn: [learns]},
    preferences: {profile_visibility: 'public'},
    reputation: {rating, review_count: reviews, completed_sessions: 15 - index}
  }));

  const localDirectoryMembers = () => {
    if (window.RELAYSKILLS_USE_REMOTE_API === true) return [];
    try {
      const saved = JSON.parse(window.localStorage?.getItem('relayskills-local-demo-v1') || 'null');
      const users = Array.isArray(saved?.users) ? saved.users : [];
      return users.map(user => ({
        ...user,
        display_name: memberName(user),
        visibility: user.preferences?.profile_visibility || 'public',
        skills_to_teach: list(user.profile?.skills_to_teach),
        skills_to_learn: list(user.profile?.skills_to_learn),
        reputation: user.reputation || {completed_sessions: 0, rating: 0, review_count: 0}
      }));
    } catch (_error) {
      return [];
    }
  };

  const visibleMembers = members => (Array.isArray(members) ? members : [])
    .filter(member => member && member.role !== 'admin' && member.status !== 'suspended' && member.visibility !== 'private' && member.preferences?.profile_visibility !== 'private')
    .sort((left, right) => Number(right.reputation?.completed_sessions || 0) - Number(left.reputation?.completed_sessions || 0) || memberName(left).localeCompare(memberName(right)));

  const portraitPositions = ['0% 0%', '100% 0%', '0% 100%', '100% 100%'];
  const isDemoMember = member => String(member?.id || '').startsWith('demo15-') || String(member?.username || '').endsWith('.demo');

  const paintLiveAvatar = (element, member, variantIndex = 0) => {
    if (!element) return;
    const profile = profileOf(member);
    const name = memberName(member);
    const avatar = safeAvatar(profile.avatar_url || member?.avatar_url);
    const demoMember = isDemoMember(member);
    const paintFallback = () => {
      element.replaceChildren();
      element.style.backgroundImage = demoMember ? "url('assets/home-reference-avatars.jpg')" : 'linear-gradient(145deg, #3b66f6, #8c6ff7 58%, #f28b6d)';
      element.style.backgroundRepeat = 'no-repeat';
      element.style.backgroundSize = demoMember ? '200% 200%' : 'cover';
      element.style.backgroundPosition = demoMember ? portraitPositions[variantIndex % portraitPositions.length] : 'center';
      element.style.color = demoMember ? 'transparent' : '#fff';
      element.style.fontSize = demoMember ? '0' : '.73rem';
      if (!demoMember) element.textContent = initials(name);
    };

    element.dataset.liveAvatar = 'true';
    element.setAttribute('aria-label', `${name} profile photo`);
    element.replaceChildren();
    if (avatar) {
      element.style.backgroundImage = 'none';
      element.style.backgroundRepeat = 'no-repeat';
      element.style.backgroundSize = 'cover';
      element.style.backgroundPosition = 'center';
      element.style.color = 'transparent';
      element.style.fontSize = '0';
      const image = document.createElement('img');
      image.src = avatar;
      image.alt = `${name} profile photo`;
      image.addEventListener('error', paintFallback, {once: true});
      element.appendChild(image);
    } else paintFallback();
  };

  const renderLiveMembers = members => {
    const cards = [...document.querySelectorAll('[data-home-member-card]')];
    const tagClasses = ['home-reference-tag-blue', 'home-reference-tag-pink', 'home-reference-tag-mint', 'home-reference-tag-purple'];
    cards.forEach((card, index) => {
      const member = members[index];
      if (!member) {
        card.hidden = true;
        return;
      }
      card.hidden = false;
      const profile = profileOf(member);
      const name = memberName(member);
      const teaching = list(profile.skills_to_teach || member.skills_to_teach);
      const learning = list(profile.skills_to_learn || member.skills_to_learn);
      const teaches = teaching.length > 0 && (!learning.length || index % 2 === 0);
      const direction = teaches ? 'Teaches' : 'Wants to learn';
      const skill = (teaches ? teaching : learning)[0] || teaching[0] || learning[0] || profile.headline || profile.professional_role || 'Open to a practical exchange';
      const rating = Number(member.reputation?.rating || 0);
      const reviews = Number(member.reputation?.review_count || 0);
      const nameSlot = card.querySelector('[data-home-member-name]');
      const directionSlot = card.querySelector('[data-home-member-direction]');
      const skillSlot = card.querySelector('[data-home-member-skill]');
      const ratingSlot = card.querySelector('[data-home-member-rating]');
      const iconSlot = card.querySelector('[data-home-member-icon]');
      const avatarSlot = card.querySelector('[data-home-avatar]');
      if (nameSlot) nameSlot.textContent = name;
      if (directionSlot) {
        directionSlot.className = `home-reference-tag ${tagClasses[index % tagClasses.length]}`;
        directionSlot.textContent = direction;
      }
      if (skillSlot) skillSlot.textContent = skill;
      if (ratingSlot) ratingSlot.innerHTML = rating > 0 ? `<i class="bx bxs-star"></i> ${rating.toFixed(1)}${reviews ? ` (${reviews})` : ''}` : 'Public member';
      if (iconSlot) iconSlot.className = `bx ${iconFor(skill)} home-reference-member-icon${index === 1 ? ' home-reference-member-icon-pink' : index === 2 ? ' home-reference-member-icon-mint' : index === 3 ? ' home-reference-member-icon-purple' : ''}`;
      paintLiveAvatar(avatarSlot, member, index);
      card.dataset.memberId = member.id || '';
      card.setAttribute('aria-label', `${name}, ${direction.toLowerCase()} ${skill}`);
    });

    const avatarHost = document.querySelector('[data-home-live-avatars]');
    if (avatarHost) {
      avatarHost.replaceChildren();
      members.slice(0, 3).forEach((member, index) => {
        const avatar = document.createElement('span');
        paintLiveAvatar(avatar, member, index);
        avatarHost.appendChild(avatar);
      });
    }
    const countSlot = document.querySelector('[data-home-member-count]');
    const countLabel = document.querySelector('[data-home-member-count-label]');
    if (countSlot) countSlot.textContent = members.length ? members.length.toLocaleString() : 'No public members yet';
    if (countLabel) countLabel.textContent = members.length === 1 ? 'public member sharing knowledge' : 'public members sharing knowledge';
    const network = document.querySelector('[data-home-demo-network]');
    if (network) network.setAttribute('aria-label', members.length ? `Live network of ${members.length} public SwapLabs members` : 'No public member profiles are available yet');
  };

  const loadLiveMembers = async () => {
    try {
      const response = await fetch('/api/members', {credentials: 'same-origin', cache: 'no-store'});
      if (!response.ok) throw new Error('Member directory unavailable');
      const payload = await response.json();
      const apiMembers = Array.isArray(payload.members) ? payload.members : Array.isArray(payload.users) ? payload.users : [];
      const members = visibleMembers(apiMembers.length ? apiMembers : localDirectoryMembers());
      renderLiveMembers(members.length ? members : staticHomepageMembers);
    } catch (_error) {
      const localMembers = visibleMembers(localDirectoryMembers());
      renderLiveMembers(localMembers.length ? localMembers : staticHomepageMembers);
    }
  };

  const applyReferenceHeader = () => {
    const header = document.querySelector('.site-header');
    if (!header) return;

    // The homepage used to paint a second, screenshot-specific header here.
    // That made it drift from the authenticated workspace header and meant it
    // could show Log in while the rest of the app showed the active member.
    // Keep the homepage composition, but let the canonical header own all
    // navigation and authentication everywhere.
    document.body.classList.add('home-reference-page');
    header.classList.add('home-reference-header');
  };

  const enableCalmMotion = () => {
    if (document.body.dataset.motionReady === 'true') return;
    document.body.dataset.motionReady = 'true';
    document.body.classList.add('home-motion-ready');

    const revealItems = [...document.querySelectorAll('.home-reference-reason, .home-spectrum-card')];
    if (!revealItems.length || !('IntersectionObserver' in window)) {
      revealItems.forEach((item) => item.classList.add('is-visible'));
      return;
    }

    const observer = new IntersectionObserver((entries, currentObserver) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        currentObserver.unobserve(entry.target);
      });
    }, {threshold: 0.16, rootMargin: '0px 0px -8%'});

    revealItems.forEach((item) => observer.observe(item));
  };

  applyReferenceHeader();
  enableCalmMotion();
  renderLiveMembers(staticHomepageMembers);
  loadLiveMembers();
  window.addEventListener('swaplabs:auth-state', applyReferenceHeader);
  window.addEventListener('load', applyReferenceHeader, {once: true});
})();
