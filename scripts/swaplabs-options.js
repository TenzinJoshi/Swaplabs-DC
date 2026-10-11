(() => {
  'use strict';

  const uniqueSorted = values => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const normalizeOptionSearch = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const displayNames = type => {
    try {
      return new Intl.DisplayNames([navigator.language || 'en'], {
        type
      });
    } catch (_error) {
      return null;
    }
  };

  // Keep this picker limited to sovereign states. Intl.DisplayNames exposes
  // every ISO region, which also includes economic areas, territories, and
  // special administrative regions such as Eurozone and European Union.
  // Those are useful for formatting, but they are not countries a member can
  // select as their country of residence.
  const sovereignCountryCodes = `AF AL DZ AD AO AG AR AM AU AT AZ BS BH BD BB BY BE BZ BJ BT BO BA BW BR BN BG BF BI CV KH CM CA CF TD CL CN CO KM CG CD CR CI HR CU CY CZ DK DJ DM DO EC EG SV GQ ER EE SZ ET FJ FI FR GA GM GE DE GH GR GD GT GN GW GY HT HN HU IS IN ID IR IQ IE IL IT JM JP JO KZ KE KI KW KG KR LA LV LB LS LR LY LI LT LU MG MW MY MV ML MT MH MR MU MX FM MD MC MN ME MA MZ MM NA NR NP NL NZ NI NE NG KP MK NO OM PK PW PA PG PY PE PH PL PT QA RO RU RW KN LC VC WS SM ST SA SN RS SC SL SG SK SI SB SO ZA SS ES LK SD SR SE CH SY TJ TZ TH TL TG TO TT TN TR TM TV UG UA AE GB US UY UZ VU VA VE VN YE ZM ZW PS`.split(' ');
  const regionNames = (() => {
    try {
      return new Intl.DisplayNames(['en'], {type: 'region'});
    } catch (_error) {
      return null;
    }
  })();
  const countries = [];
  const countryCodesByName = new Map();
  const normalizeCountry = value => String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  sovereignCountryCodes.forEach(code => {
    let name = '';
    try {
      name = regionNames?.of(code) || '';
    } catch (_error) {
      name = '';
    }
    if (name && name !== code && !/unknown region/i.test(name)) {
      countries.push(name);
      countryCodesByName.set(normalizeCountry(name), code);
    }
  });

  // A country can contain several zones, so this is intentionally the
  // primary/default zone used for profile setup. Calendar entries still keep
  // an IANA timezone and can be adjusted by the service when a more precise
  // location is available.
  const countryTimezones = {
    AD: 'Europe/Andorra', AE: 'Asia/Dubai', AF: 'Asia/Kabul', AG: 'America/Antigua', AI: 'America/Anguilla', AL: 'Europe/Tirane', AM: 'Asia/Yerevan', AO: 'Africa/Luanda', AQ: 'Antarctica/Troll', AR: 'America/Argentina/Buenos_Aires', AS: 'Pacific/Pago_Pago', AT: 'Europe/Vienna', AU: 'Australia/Sydney', AW: 'America/Aruba', AZ: 'Asia/Baku',
    BA: 'Europe/Sarajevo', BB: 'America/Barbados', BD: 'Asia/Dhaka', BE: 'Europe/Brussels', BF: 'Africa/Ouagadougou', BG: 'Europe/Sofia', BH: 'Asia/Bahrain', BI: 'Africa/Bujumbura', BJ: 'Africa/Porto-Novo', BL: 'America/St_Barthelemy', BM: 'Atlantic/Bermuda', BN: 'Asia/Brunei', BO: 'America/La_Paz', BQ: 'America/Kralendijk', BR: 'America/Sao_Paulo', BS: 'America/Nassau', BT: 'Asia/Thimphu', BV: 'UTC', BW: 'Africa/Gaborone', BY: 'Europe/Minsk', BZ: 'America/Belize',
    CA: 'America/Toronto', CC: 'Indian/Cocos', CD: 'Africa/Kinshasa', CF: 'Africa/Bangui', CG: 'Africa/Brazzaville', CH: 'Europe/Zurich', CI: 'Africa/Abidjan', CK: 'Pacific/Rarotonga', CL: 'America/Santiago', CM: 'Africa/Douala', CN: 'Asia/Shanghai', CO: 'America/Bogota', CR: 'America/Costa_Rica', CU: 'America/Havana', CV: 'Atlantic/Cape_Verde', CW: 'America/Curacao', CX: 'Indian/Christmas', CY: 'Asia/Nicosia', CZ: 'Europe/Prague',
    DE: 'Europe/Berlin', DJ: 'Africa/Djibouti', DK: 'Europe/Copenhagen', DM: 'America/Dominica', DO: 'America/Santo_Domingo', DZ: 'Africa/Algiers',
    EC: 'America/Guayaquil', EE: 'Europe/Tallinn', EG: 'Africa/Cairo', EH: 'Africa/El_Aaiun', ER: 'Africa/Asmara', ES: 'Europe/Madrid', ET: 'Africa/Addis_Ababa',
    FI: 'Europe/Helsinki', FJ: 'Pacific/Fiji', FK: 'Atlantic/Stanley', FM: 'Pacific/Pohnpei', FO: 'Atlantic/Faroe', FR: 'Europe/Paris',
    GA: 'Africa/Libreville', GB: 'Europe/London', GD: 'America/Grenada', GE: 'Asia/Tbilisi', GF: 'America/Cayenne', GG: 'Europe/Guernsey', GH: 'Africa/Accra', GI: 'Europe/Gibraltar', GL: 'America/Nuuk', GM: 'Africa/Banjul', GN: 'Africa/Conakry', GP: 'America/Guadeloupe', GQ: 'Africa/Malabo', GR: 'Europe/Athens', GS: 'Atlantic/South_Georgia', GT: 'America/Guatemala', GU: 'Pacific/Guam', GW: 'Africa/Bissau', GY: 'America/Guyana',
    HK: 'Asia/Hong_Kong', HM: 'UTC', HN: 'America/Tegucigalpa', HR: 'Europe/Zagreb', HT: 'America/Port-au-Prince', HU: 'Europe/Budapest',
    ID: 'Asia/Jakarta', IE: 'Europe/Dublin', IL: 'Asia/Jerusalem', IM: 'Europe/Isle_of_Man', IN: 'Asia/Kolkata', IO: 'Indian/Chagos', IQ: 'Asia/Baghdad', IR: 'Asia/Tehran', IS: 'Atlantic/Reykjavik', IT: 'Europe/Rome',
    JE: 'Europe/Jersey', JM: 'America/Jamaica', JO: 'Asia/Amman', JP: 'Asia/Tokyo',
    KE: 'Africa/Nairobi', KG: 'Asia/Bishkek', KH: 'Asia/Phnom_Penh', KI: 'Pacific/Tarawa', KM: 'Indian/Comoro', KN: 'America/St_Kitts', KP: 'Asia/Pyongyang', KR: 'Asia/Seoul', KW: 'Asia/Kuwait', KY: 'America/Cayman', KZ: 'Asia/Almaty',
    LA: 'Asia/Vientiane', LB: 'Asia/Beirut', LC: 'America/St_Lucia', LI: 'Europe/Vaduz', LK: 'Asia/Colombo', LR: 'Africa/Monrovia', LS: 'Africa/Maseru', LT: 'Europe/Vilnius', LU: 'Europe/Luxembourg', LV: 'Europe/Riga', LY: 'Africa/Tripoli',
    MA: 'Africa/Casablanca', MC: 'Europe/Monaco', MD: 'Europe/Chisinau', ME: 'Europe/Podgorica', MF: 'America/Marigot', MG: 'Indian/Antananarivo', MH: 'Pacific/Majuro', MK: 'Europe/Skopje', ML: 'Africa/Bamako', MM: 'Asia/Yangon', MN: 'Asia/Ulaanbaatar', MO: 'Asia/Macau', MP: 'Pacific/Saipan', MQ: 'America/Martinique', MR: 'Africa/Nouakchott', MS: 'America/Montserrat', MT: 'Europe/Malta', MU: 'Indian/Mauritius', MV: 'Indian/Maldives', MW: 'Africa/Blantyre', MX: 'America/Mexico_City', MY: 'Asia/Kuala_Lumpur', MZ: 'Africa/Maputo',
    NA: 'Africa/Windhoek', NC: 'Pacific/Noumea', NE: 'Africa/Niamey', NF: 'Pacific/Norfolk', NG: 'Africa/Lagos', NI: 'America/Managua', NL: 'Europe/Amsterdam', NO: 'Europe/Oslo', NP: 'Asia/Kathmandu', NR: 'Pacific/Nauru', NU: 'Pacific/Niue', NZ: 'Pacific/Auckland',
    OM: 'Asia/Muscat',
    PA: 'America/Panama', PE: 'America/Lima', PF: 'Pacific/Tahiti', PG: 'Pacific/Port_Moresby', PH: 'Asia/Manila', PK: 'Asia/Karachi', PL: 'Europe/Warsaw', PM: 'America/Miquelon', PN: 'Pacific/Pitcairn', PR: 'America/Puerto_Rico', PS: 'Asia/Gaza', PT: 'Europe/Lisbon', PW: 'Pacific/Palau', PY: 'America/Asuncion',
    QA: 'Asia/Qatar', RE: 'Indian/Reunion', RO: 'Europe/Bucharest', RS: 'Europe/Belgrade', RU: 'Europe/Moscow', RW: 'Africa/Kigali',
    SA: 'Asia/Riyadh', SB: 'Pacific/Guadalcanal', SC: 'Indian/Mahe', SD: 'Africa/Khartoum', SE: 'Europe/Stockholm', SG: 'Asia/Singapore', SH: 'Atlantic/St_Helena', SI: 'Europe/Ljubljana', SJ: 'Arctic/Longyearbyen', SK: 'Europe/Bratislava', SL: 'Africa/Freetown', SM: 'Europe/San_Marino', SN: 'Africa/Dakar', SO: 'Africa/Mogadishu', SR: 'America/Paramaribo', SS: 'Africa/Juba', ST: 'Africa/Sao_Tome', SV: 'America/El_Salvador', SX: 'America/Lower_Princes', SY: 'Asia/Damascus', SZ: 'Africa/Mbabane',
    TC: 'America/Grand_Turk', TD: 'Africa/Ndjamena', TF: 'Indian/Kerguelen', TG: 'Africa/Lome', TH: 'Asia/Bangkok', TJ: 'Asia/Dushanbe', TK: 'Pacific/Fakaofo', TL: 'Asia/Dili', TM: 'Asia/Ashgabat', TN: 'Africa/Tunis', TO: 'Pacific/Tongatapu', TR: 'Europe/Istanbul', TT: 'America/Port_of_Spain', TV: 'Pacific/Funafuti', TW: 'Asia/Taipei', TZ: 'Africa/Dar_es_Salaam',
    UA: 'Europe/Kyiv', UG: 'Africa/Kampala', UM: 'Pacific/Wake', US: 'America/New_York', UY: 'America/Montevideo', UZ: 'Asia/Tashkent',
    VA: 'Europe/Vatican', VC: 'America/St_Vincent', VE: 'America/Caracas', VG: 'America/Tortola', VI: 'America/St_Thomas', VN: 'Asia/Ho_Chi_Minh', VU: 'Pacific/Efate',
    WF: 'Pacific/Wallis', WS: 'Pacific/Apia', YE: 'Asia/Aden', YT: 'Indian/Mayotte', ZA: 'Africa/Johannesburg', ZM: 'Africa/Lusaka', ZW: 'Africa/Harare'
  };
  // IANA keeps several named zones for countries that span more than one
  // civil time zone. The profile picker uses these representative regional
  // zones instead of forcing everyone in a country onto its largest city.
  const multiCountryTimezones = {
    AR: ['America/Argentina/Buenos_Aires', 'America/Argentina/Cordoba', 'America/Argentina/Salta', 'America/Argentina/Jujuy', 'America/Argentina/Tucuman', 'America/Argentina/Catamarca', 'America/Argentina/La_Rioja', 'America/Argentina/San_Juan', 'America/Argentina/Mendoza', 'America/Argentina/San_Luis', 'America/Argentina/Rio_Gallegos', 'America/Argentina/Ushuaia'],
    AU: ['Australia/Sydney', 'Australia/Lord_Howe', 'Antarctica/Macquarie', 'Australia/Hobart', 'Australia/Melbourne', 'Australia/Broken_Hill', 'Australia/Brisbane', 'Australia/Lindeman', 'Australia/Adelaide', 'Australia/Darwin', 'Australia/Perth', 'Australia/Eucla'],
    BR: ['America/Sao_Paulo', 'America/Noronha', 'America/Belem', 'America/Fortaleza', 'America/Recife', 'America/Araguaina', 'America/Maceio', 'America/Bahia', 'America/Campo_Grande', 'America/Cuiaba', 'America/Santarem', 'America/Porto_Velho', 'America/Boa_Vista', 'America/Manaus', 'America/Eirunepe', 'America/Rio_Branco'],
    CA: ['America/Toronto', 'America/St_Johns', 'America/Halifax', 'America/Glace_Bay', 'America/Moncton', 'America/Goose_Bay', 'America/Blanc-Sablon', 'America/Iqaluit', 'America/Atikokan', 'America/Winnipeg', 'America/Resolute', 'America/Rankin_Inlet', 'America/Regina', 'America/Swift_Current', 'America/Edmonton', 'America/Cambridge_Bay', 'America/Inuvik', 'America/Vancouver', 'America/Creston', 'America/Dawson_Creek', 'America/Fort_Nelson', 'America/Whitehorse', 'America/Dawson'],
    CD: ['Africa/Kinshasa', 'Africa/Lubumbashi'],
    CL: ['America/Santiago', 'America/Coyhaique', 'America/Punta_Arenas', 'Pacific/Easter'],
    CN: ['Asia/Shanghai', 'Asia/Urumqi'],
    CY: ['Asia/Nicosia', 'Asia/Famagusta'],
    DE: ['Europe/Berlin', 'Europe/Busingen'],
    EC: ['America/Guayaquil', 'Pacific/Galapagos'],
    ES: ['Europe/Madrid', 'Africa/Ceuta', 'Atlantic/Canary'],
    FM: ['Pacific/Pohnpei', 'Pacific/Chuuk', 'Pacific/Kosrae'],
    ID: ['Asia/Jakarta', 'Asia/Pontianak', 'Asia/Makassar', 'Asia/Jayapura'],
    KI: ['Pacific/Tarawa', 'Pacific/Kanton', 'Pacific/Kiritimati'],
    KZ: ['Asia/Almaty', 'Asia/Qyzylorda', 'Asia/Qostanay', 'Asia/Aqtobe', 'Asia/Aqtau', 'Asia/Atyrau', 'Asia/Oral'],
    MH: ['Pacific/Majuro', 'Pacific/Kwajalein'],
    MN: ['Asia/Ulaanbaatar', 'Asia/Hovd'],
    MX: ['America/Mexico_City', 'America/Cancun', 'America/Merida', 'America/Monterrey', 'America/Matamoros', 'America/Chihuahua', 'America/Ciudad_Juarez', 'America/Ojinaga', 'America/Mazatlan', 'America/Bahia_Banderas', 'America/Hermosillo', 'America/Tijuana'],
    MY: ['Asia/Kuala_Lumpur', 'Asia/Kuching'],
    NZ: ['Pacific/Auckland', 'Pacific/Chatham'],
    PG: ['Pacific/Port_Moresby', 'Pacific/Bougainville'],
    PS: ['Asia/Gaza', 'Asia/Hebron'],
    PT: ['Europe/Lisbon', 'Atlantic/Madeira', 'Atlantic/Azores'],
    RU: ['Europe/Moscow', 'Europe/Kaliningrad', 'Europe/Samara', 'Asia/Yekaterinburg', 'Asia/Omsk', 'Asia/Krasnoyarsk', 'Asia/Irkutsk', 'Asia/Yakutsk', 'Asia/Vladivostok', 'Asia/Magadan', 'Asia/Kamchatka'],
    UA: ['Europe/Kyiv', 'Europe/Simferopol'],
    US: ['America/New_York', 'America/Detroit', 'America/Kentucky/Louisville', 'America/Kentucky/Monticello', 'America/Indiana/Indianapolis', 'America/Indiana/Vincennes', 'America/Indiana/Winamac', 'America/Indiana/Marengo', 'America/Indiana/Petersburg', 'America/Indiana/Vevay', 'America/Chicago', 'America/Indiana/Tell_City', 'America/Indiana/Knox', 'America/Menominee', 'America/North_Dakota/Center', 'America/North_Dakota/New_Salem', 'America/North_Dakota/Beulah', 'America/Denver', 'America/Boise', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'America/Juneau', 'America/Sitka', 'America/Metlakatla', 'America/Yakutat', 'America/Nome', 'America/Adak', 'Pacific/Honolulu'],
    UZ: ['Asia/Tashkent', 'Asia/Samarkand']
  };
  const countryCodeAliases = {
    usa: 'US', 'us': 'US', 'united states of america': 'US', 'uk': 'GB', 'united kingdom': 'GB', 'great britain': 'GB',
    'south korea': 'KR', 'north korea': 'KP', 'russia': 'RU', 'vietnam': 'VN', 'laos': 'LA',
    'iran': 'IR', 'syria': 'SY', 'bolivia': 'BO', 'venezuela': 'VE', 'tanzania': 'TZ',
    'moldova': 'MD', 'brunei': 'BN', 'czech republic': 'CZ', 'turkey': 'TR', 'ivory coast': 'CI',
    'palestine': 'PS', 'taiwan': 'TW', 'hong kong': 'HK', 'macau': 'MO', 'kosovo': 'XK',
    'united states': 'US', 'cabo verde': 'CV', 'the gambia': 'GM', 'czechia': 'CZ',
    'eswatini': 'SZ', 'north macedonia': 'MK', 'timor leste': 'TL', 'vatican city': 'VA',
    'sao tome and principe': 'ST', 'democratic republic of the congo': 'CD', 'republic of the congo': 'CG',
    'russian federation': 'RU'
  };
  const browserTimezone = () => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_error) { return 'UTC'; }
  };
  const countryCodeForName = country => {
    const normalized = normalizeCountry(country);
    if (!normalized) return '';
    return countryCodeAliases[normalized] || countryCodesByName.get(normalized) || '';
  };
  const timezonesForCountry = country => {
    const code = countryCodeForName(country);
    if (!code) return [];
    const zones = multiCountryTimezones[code] || (countryTimezones[code] ? [countryTimezones[code]] : []);
    const supportedZones = hasNativeTimezones ? zones.filter(zone => timezones.includes(zone)) : zones;
    return [...new Set(supportedZones)];
  };
  const timezoneForCountry = country => timezonesForCountry(country)[0] || browserTimezone();
  const timezoneLabel = zone => {
    const value = String(zone || '').trim();
    if (!value) return '';
    const parts = value.split('/');
    const place = parts.at(-1).replaceAll('_', ' ');
    return `${place} (${value})`;
  };

  const languageCodes =
    `aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu`
    .split(/\s+/);
  const languageNames = displayNames('language');
  const languages = languageCodes.map(code => {
    try {
      return languageNames?.of(code) || code;
    } catch (_error) {
      return code;
    }
  });
  languages.push(
    'American Sign Language', 'British Sign Language', 'Indian Sign Language', 'International Sign',
    'Auslan', 'New Zealand Sign Language', 'Other / self-described'
  );
  const NOTHING_FOR_NOW = 'Nothing for now';
  const learningLanguages = [NOTHING_FOR_NOW, ...uniqueSorted(languages)];

  const skillCategories = {
    technology: `Front-end development|Back-end development|Full-stack development|Web development|Responsive web design|HTML|CSS|JavaScript|TypeScript|React|Vue.js|Angular|Svelte|Next.js|Nuxt.js|Node.js|Python programming|Django|Flask|FastAPI|Ruby on Rails|PHP|Laravel|Java|Spring Boot|C#|.NET development|C++ programming|Rust programming|Go programming|Kotlin|Swift|SQL|Database design|PostgreSQL|MySQL|SQLite|MongoDB|Redis|GraphQL|REST API design|API integration|Authentication systems|WebSockets|Serverless applications|Cloud functions|Microservices|System architecture|Algorithms|Data structures|Software testing|Test automation|Quality assurance|Accessibility engineering|Performance optimization|Browser DevTools|Version control|Git|GitHub|Open-source contribution|Code review|Refactoring|Technical documentation|Prompt engineering|AI application development|Mobile app development|Android development|iOS development|Flutter|React Native|Unity game development|Unreal Engine|Game programming|Embedded programming|Operating systems|Linux administration|Shell scripting|Networking|Computer hardware|IT support|Technical troubleshooting`.split('|'),
    dataAndAi: `Data analysis|Data visualization|Data engineering|Data modeling|Data warehousing|ETL pipelines|Business intelligence|Power BI|Tableau|Looker Studio|Excel data analysis|Google Sheets|Statistics|Machine learning|Deep learning|Natural language processing|Computer vision|Recommender systems|Predictive modeling|Time series analysis|Python data science|R programming|Jupyter notebooks|TensorFlow|PyTorch|Scikit-learn|SQL analytics|A/B testing|Data cleaning|Survey design|Web scraping|Research methods|Cybersecurity|Ethical hacking|Penetration testing|Threat modeling|Security awareness|Digital forensics|Incident response|Privacy engineering|Identity and access management|Network security|Cloud security|Cryptography|Secure coding|DevSecOps|Risk assessment|Compliance basics|Blockchain development|Smart contracts|Web3 development`.split('|'),
    design: `UI design|UX design|Product design|UX research|Interaction design|Visual design|Graphic design|Brand identity|Logo design|Typography|Color theory|Design systems|Design tokens|Prototyping|Figma|Adobe XD|Sketch|Wireframing|User testing|Information architecture|Service design|Design thinking|Motion design|Animation|3D modeling|Blender|CAD design|Illustration|Digital illustration|Icon design|Layout design|Presentation design|Dashboard design|Infographic design|Web design|Responsive design|Accessibility design|Content design|Design critique|Usability testing|Design documentation|Creative direction|Art direction|Packaging design|Print design|Publication design|Data visualization design`.split('|'),
    writingAndCommunication: `Creative writing|Copywriting|Content writing|Technical writing|UX writing|Blogging|Journalism|Editing|Proofreading|Resume writing|Cover letter writing|Grant writing|Proposal writing|Academic writing|Research writing|Storytelling|Scriptwriting|Poetry|Songwriting|Screenwriting|Public speaking|Presentation skills|Debate|Active listening|Interviewing|Negotiation|Facilitation|Conflict resolution|Interpersonal communication|Business communication|Email writing|Social media writing|SEO writing|Newsletter writing|Speech writing|Voiceover scripting|Community moderation|Meeting facilitation|Workshop facilitation|Professional networking|Conversation skills|Persuasive writing|Personal storytelling|Book writing|Technical editing|Copy editing|Fact checking|Media literacy|Critical thinking|Logic|Philosophy|Ethics`.split('|'),
    businessAndCareer: `Entrepreneurship|Business planning|Market research|Competitive analysis|Product management|Product strategy|Project management|Agile project management|Scrum|Kanban|Leadership|Team management|People operations|Recruiting|Candidate interviewing|Career coaching|Career planning|Personal branding|Sales|Consultative selling|Negotiation|Account management|Customer support|Customer success|Community management|Event planning|Operations management|Supply chain management|Procurement|Vendor management|Process improvement|Business analysis|Requirements gathering|Financial planning|Budgeting|Bookkeeping|Accounting basics|Financial modeling|Investing basics|Stock analysis|Personal finance|Tax basics|Economics|Marketing strategy|Digital marketing|SEO|Search engine marketing|Social media marketing|Email marketing|Content marketing|Growth marketing|Brand strategy|Public relations|Market positioning|Customer research|Analytics|Google Analytics|Conversion optimization|Fundraising|Grant management|Nonprofit management|Policy analysis|Legal research|Contract basics|Organizational development|Change management|Business presentations|Facilitation|Professional mentoring`.split('|'),
    educationAndLanguages: `English conversation|Spanish conversation|French conversation|German conversation|Italian conversation|Portuguese conversation|Hindi conversation|Bengali conversation|Nepali conversation|Mandarin conversation|Japanese conversation|Korean conversation|Arabic conversation|Russian conversation|Sanskrit reading|American Sign Language|British Sign Language|International Sign|Pronunciation coaching|Grammar coaching|Vocabulary building|Language exchange facilitation|ESL teaching|Lesson planning|Tutoring|Exam preparation|Study skills|Note-taking|Time management|Memory techniques|Speed reading|Reading comprehension|Early childhood education|Montessori education|Curriculum design|Classroom management|Special education|STEM education|Math tutoring|Science tutoring|Coding education|Music education|Literacy tutoring|Handwriting|Homeschool planning|Study planning|Peer mentoring|Public workshop teaching|Online teaching|Instructional design|E-learning design|Course creation|Educational technology|Academic advising|Library research|Research supervision|Learning coaching`.split('|'),
    mathAndScience: `Arithmetic|Algebra|Geometry|Trigonometry|Calculus|Linear algebra|Discrete mathematics|Probability|Statistics|Physics|Classical mechanics|Astronomy|Chemistry|Organic chemistry|Biochemistry|Biology|Microbiology|Ecology|Geology|Environmental science|Climate science|Oceanography|Neuroscience|Psychology basics|Sociology|Anthropology|Political science|Geography|GIS mapping|Cartography|Meteorology|Botany|Zoology|Genetics|Lab techniques|Scientific illustration|Scientific communication|Research design|Experimental design|Scientific computing|Quantum concepts|Engineering fundamentals|Civil engineering basics|Mechanical engineering basics|Electrical engineering basics|Chemical engineering basics|Architecture basics`.split('|'),
    musicAndAudio: `Guitar|Acoustic guitar|Electric guitar|Bass guitar|Ukulele|Piano|Keyboard|Drums|Percussion|Violin|Viola|Cello|Double bass|Flute|Clarinet|Saxophone|Trumpet|Trombone|Harmonica|Singing|Vocal technique|Choir singing|Songwriting|Music theory|Ear training|Sight reading|Improvisation|Jazz improvisation|Classical music|Beatboxing|DJing|Music production|Audio engineering|Mixing|Mastering|Recording|Ableton Live|FL Studio|Logic Pro|GarageBand|Pro Tools|Sound design|Podcast production|Field recording|Live sound|Music business|Music arrangement|Orchestration|Composition|Conducting|Gospel music|Folk music|Electronic music|Music history|Music appreciation|Karaoke|Turntablism|Radio production|Voice acting|Narration|Audio restoration|MIDI sequencing`.split('|'),
    photoVideoAndMedia: `Photography|Portrait photography|Street photography|Landscape photography|Wildlife photography|Product photography|Food photography|Sports photography|Travel photography|Smartphone photography|Photo editing|Adobe Lightroom|Adobe Photoshop|Photo retouching|Digital asset management|Videography|Filmmaking|Cinematography|Directing|Screenwriting|Video editing|Adobe Premiere Pro|Final Cut Pro|DaVinci Resolve|After Effects|Motion graphics|Color grading|Stop motion|Animation|YouTube production|Livestreaming|OBS Studio|Short-form video|Documentary making|Interview production|Lighting for video|Lighting for photography|Green screen production|Storyboarding|Casting|Film criticism|Media production|Podcast hosting|Podcast editing|Social media video|Teleprompter operation|Drone photography|Drone videography|Aerial mapping|Broadcast production|Live event production|Content creator strategy|Thumbnail design|Subtitling|Captioning|Audio-video troubleshooting`.split('|'),
    foodAndHospitality: `Cooking basics|Knife skills|Meal preparation|Meal planning|Baking|Bread baking|Sourdough|Pastry|Cake decorating|Chocolate making|Candy making|Pasta making|Pizza making|Vegetarian cooking|Vegan cooking|Indian cooking|Nepali cooking|Mexican cooking|Italian cooking|Chinese cooking|Japanese cooking|Thai cooking|Korean cooking|Middle Eastern cooking|French cooking|Mediterranean cooking|Barbecue|Grilling meat|Smoking meat|Charcoal grilling|Gas grilling|Steak cooking|Burger making|Seafood cooking|Soups and stews|Sauce making|Spice blending|Fermentation|Pickling|Food preservation|Coffee brewing|Espresso making|Tea preparation|Cocktail mixing|Mocktail making|Nutrition basics|Food safety|Catering|Restaurant service|Menu planning|Food styling|Farm-to-table cooking|Street food cooking|Indian sweets|Vegetarian baking|Kitchen organization|Kitchen gardening`.split('|'),
    makerHomeAndRepair: `Woodworking|Carpentry|Furniture making|Cabinetry|Joinery|Wood carving|Welding|Metalworking|Blacksmithing|Plumbing basics|Electrical basics|Home wiring|Painting walls|Drywall repair|Tiling|Flooring|Masonry|Concrete work|Roofing basics|Home renovation|Interior decorating|Home organization|Sewing|Hand sewing|Machine sewing|Embroidery|Knitting|Crochet|Quilting|Leatherworking|Jewelry making|Candle making|Soap making|Pottery|Ceramics|Sculpting|3D printing|3D printer maintenance|Laser cutting|CNC machining|Arduino|Raspberry Pi|Electronics repair|Soldering|Robotics|Drone building|Bicycle repair|Car maintenance|Motorcycle maintenance|Appliance repair|Knife sharpening|Gardening|Vegetable gardening|Composting|Hydroponics|Landscaping|Flower arranging|Beekeeping|Home energy efficiency|Furniture restoration|Picture framing|Lock repair basics|Sustainable living|Rainwater harvesting|Basic construction|Tool safety`.split('|'),
    artsCraftsAndFashion: `Drawing|Sketching|Watercolor painting|Acrylic painting|Oil painting|Gouache painting|Calligraphy|Hand lettering|Digital art|Character design|Concept art|Comic art|Manga drawing|Portrait drawing|Art history|Printmaking|Screen printing|Textile design|Fashion design|Pattern making|Tailoring|Costume design|Fashion illustration|Styling|Personal styling|Makeup artistry|Hair styling|Nail art|Nail care|Face painting|Origami|Paper crafts|Scrapbooking|Collage|Mosaic art|Glass art|Stained glass|Basket weaving|Macrame|Flower crafts|Miniature making|Model building|Prop making|Cosplay design|Theater set design|Visual journaling|Art curation|Creative arts|Craft fair planning|Handmade business`.split('|'),
    sportsFitnessAndOutdoors: `Yoga|Meditation|Mindfulness|Breathwork|Strength training|Weightlifting|Bodybuilding|Calisthenics|Running|Marathon training|Jogging|Walking|Cycling|Mountain biking|Road cycling|Swimming|Surfing|Kayaking|Canoeing|Sailing|Rowing|Hiking|Backpacking|Rock climbing|Bouldering|Mountaineering|Skiing|Snowboarding|Skating|Ice skating|Roller skating|Tennis|Badminton|Table tennis|Basketball|Football|Soccer|Cricket|Volleyball|Baseball|Rugby|Hockey|Golf|Boxing|Kickboxing|Muay Thai|Judo|Karate|Taekwondo|Brazilian jiu-jitsu|Wrestling|Self-defense|Archery|Darts|Dance|Ballet|Hip-hop dance|Salsa dancing|Ballroom dancing|Contemporary dance|Breakdancing|Jazz dance|Tap dance|Gymnastics|Cheerleading|Pilates|Barre|Personal training|Sports coaching|Sports nutrition basics|Refereeing|Outdoor survival|Camping|Orienteering|Map reading|Fishing|Birdwatching|Nature observation|Trail safety|First aid|CPR|Emergency preparedness`.split('|'),
    lifestyleAndCommunity: `Pet care|Dog training|Cat care|Horse care|Aquarium care|Animal welfare|Parenting basics|Child development|Elder care basics|First aid|CPR|Emergency preparedness|Public safety|Personal budgeting|Financial literacy|Habit building|Productivity|Time management|Goal setting|Journaling|Stress management|Sleep hygiene|Mindful living|Meditation coaching|Travel planning|Trip planning|Packing efficiently|Map navigation|Public transit navigation|Driving basics|Road safety|Car camping|Hospitality|Hosting gatherings|Table setting|Gift wrapping|Home entertaining|Volunteer coordination|Community organizing|Peer support|Mentoring|Networking|Relationship communication|Friendship building|Cross-cultural communication|Accessibility awareness|Sustainability|Waste reduction|Recycling|Climate action|Urban gardening|Local history|Genealogy|Public service|Civic engagement|Fundraising events|Conflict mediation|Restorative conversations|Personal safety|Digital literacy|Computer basics|Smartphone basics|Online privacy|Password management|Remote work skills|Virtual collaboration|Meeting etiquette`.split('|')
  };
  const skills = Object.values(skillCategories).flat();
  const popularSkills = [
    'English conversation', 'Python programming', 'Web development', 'Graphic design',
    'Public speaking', 'Photography', 'Excel data analysis', 'Cooking basics',
    'Guitar', 'Spanish conversation', 'Project management', 'Yoga'
  ];
  const POPULAR_SKILL_COUNT = 30;

  let timezones = [];
  let hasNativeTimezones = false;
  try {
    timezones = Intl.supportedValuesOf('timeZone');
    hasNativeTimezones = true;
  } catch (_error) {
    timezones = [
      'UTC', 'Africa/Cairo', 'Africa/Johannesburg', 'America/Anchorage', 'America/Chicago',
      'America/Denver', 'America/Los_Angeles', 'America/Mexico_City', 'America/New_York',
      'America/Sao_Paulo', 'Asia/Dubai', 'Asia/Hong_Kong', 'Asia/Kolkata', 'Asia/Seoul',
      'Asia/Shanghai', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Melbourne', 'Australia/Sydney',
      'Europe/Berlin', 'Europe/London', 'Europe/Madrid', 'Europe/Paris', 'Pacific/Auckland'
    ];
  }
  timezones = ['UTC', 'Asia/Kolkata', 'Asia/Kathmandu', 'Europe/Kyiv', ...timezones, 'Other / custom timezone'];

  const occupations =
    `Accountant|Actor|Actuary|Administrative Assistant|Aerospace Engineer|Agricultural Scientist|Animator|Anthropologist|App Developer|Architect|Archivist|Art Director|Artist|Astronomer|Attorney|Audio Engineer|Auditor|Author|Baker|Banker|Barber|Bartender|Biochemist|Biologist|Biomedical Engineer|Bookkeeper|Brand Strategist|Business Analyst|Business Owner|Carpenter|Chef|Chemist|Civil Engineer|Clinical Researcher|Coach|Community Manager|Compliance Officer|Composer|Construction Manager|Consultant|Content Creator|Content Designer|Copy Editor|Copywriter|Counsellor|Customer Success Manager|Cybersecurity Analyst|Dancer|Data Analyst|Data Engineer|Data Scientist|Database Administrator|Dentist|Dietitian|Digital Marketer|Director|Doctor|Economist|Editor|Educator|Electrical Engineer|Entrepreneur|Environmental Scientist|Event Planner|Executive Assistant|Fashion Designer|Film Director|Financial Adviser|Financial Analyst|Fitness Trainer|Florist|Founder|Frontend Developer|Full-stack Developer|Game Designer|Geologist|Graphic Designer|Hair Stylist|Historian|Human Resources Specialist|Illustrator|Industrial Designer|Information Architect|Insurance Specialist|Interior Designer|Interpreter|Journalist|Laboratory Technician|Landscape Architect|Language Coach|Lawyer|Librarian|Machine Learning Engineer|Marketing Manager|Mathematician|Mechanical Engineer|Medical Researcher|Mentor|Musician|Network Engineer|Nurse|Nutritionist|Occupational Therapist|Operations Manager|Optometrist|Photographer|Physical Therapist|Physician|Policy Analyst|Product Designer|Product Manager|Professor|Program Manager|Project Manager|Psychologist|Public Relations Specialist|Quality Assurance Engineer|Recruiter|Researcher|Sales Manager|School Teacher|Security Engineer|Social Media Manager|Social Worker|Software Engineer|Sound Designer|Statistician|Student|Supply Chain Manager|Systems Administrator|Technical Writer|Therapist|Translator|Tutor|UI Designer|UX Designer|UX Researcher|Veterinarian|Video Editor|Videographer|Visual Designer|Web Designer|Web Developer|Writer|Retired|Career Break|Volunteer|Other / self-described`
    .split('|');

  const professionalRoles =
    `Apprentice|Assistant|Associate|Coordinator|Contributor|Consultant|Contractor|Director|Educator|Executive|Expert|Facilitator|Founder|Freelancer|Head of Department|Independent Professional|Individual Contributor|Intern|Junior Specialist|Lead|Manager|Mentor|Owner|Partner|Principal|Professor|Research Fellow|Senior Specialist|Specialist|Student|Supervisor|Teacher|Team Lead|Trainee|Tutor|Vice President|Volunteer|Other / self-described`
    .split('|');

  const values = {
    countries: uniqueSorted(countries),
    languages: uniqueSorted(languages),
    skills: uniqueSorted(skills),
    learningLanguages,
    timezones: uniqueSorted(timezones),
    occupations: uniqueSorted(occupations),
    roles: uniqueSorted(professionalRoles),
    pronouns: ['He / him', 'She / her', 'They / them', 'He / they', 'She / they', 'Any pronouns', 'Use my name',
      'Prefer not to say', 'Other / self-described'
    ],
    genders: ['Woman', 'Man', 'Non-binary', 'Genderqueer', 'Agender', 'Prefer not to say', 'Other / self-described'],
    ages: Array.from({
      length: 118
    }, (_, index) => String(index + 3))
  };

  const escapeOptionText = value => String(value || '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));

  function setupCountrySelect(select) {
    const requested = select.dataset.pendingValue || select.value || '';
    const options = values.countries.map(country =>
      `<option value="${escapeOptionText(country)}">${escapeOptionText(country)}</option>`).join('');
    select.innerHTML = `<option value="">Choose a country</option>${options}`;
    select.value = values.countries.includes(requested) ? requested : '';
    delete select.dataset.pendingValue;
    select.dataset.countrySelectReady = 'true';
    select.setAttribute('autocomplete', 'country-name');
  }

  function setupCountryTimezoneSelect(select) {
    const country = select.form?.elements?.namedItem('country');
    if (!country) return;
    const update = () => {
      const selected = select.dataset.pendingValue || select.value || '';
      const zones = timezonesForCountry(country.value);
      const available = zones.length ? zones : [selected || 'UTC'];
      select.innerHTML = available.map(zone =>
        `<option value="${escapeOptionText(zone)}">${escapeOptionText(timezoneLabel(zone))}</option>`).join('');
      select.value = zones.includes(selected) ? selected : available[0];
      delete select.dataset.pendingValue;
    };
    country.addEventListener('input', update);
    country.addEventListener('change', update);
    update();
    select.dataset.countryTimezoneReady = 'true';
  }

  function addDatalist(input, key) {
    const options = values[key] || [];
    const id = `swaplabs-${key}-options`;
    let datalist = document.getElementById(id);
    if (!datalist) {
      datalist = document.createElement('datalist');
      datalist.id = id;
      datalist.innerHTML = options.map(option =>
        `<option value="${String(option).replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></option>`).join('');
      document.body.appendChild(datalist);
    }
    input.setAttribute('list', id);
    input.setAttribute('autocomplete', 'off');
  }

  const splitPickerValues = value => {
    if (Array.isArray(value)) return value.flatMap(item => splitPickerValues(item));
    const raw = String(value || '').trim();
    if (!raw) return [];
    return raw.split(/[,;\n]/).map(item => item.trim()).filter(Boolean);
  };

  function setupSkillPicker(input) {
    if (input.__relaySkillsSkillPicker) return input.__relaySkillsSkillPicker;

    const field = input.parentElement;
    const host = document.createElement('div');
    host.className = 'skill-picker';
    host.dataset.skillPickerHost = 'true';
    field.insertBefore(host, input);
    host.appendChild(input);

    const originalRequired = input.required;
    input.dataset.skillPickerRequired = String(originalRequired);
    input.removeAttribute('required');
    input.classList.add('skill-picker-value');
    input.setAttribute('aria-hidden', 'true');
    input.tabIndex = -1;

    const selectedHost = document.createElement('div');
    selectedHost.className = 'skill-picker-selected';
    selectedHost.setAttribute('aria-live', 'polite');

    const searchLabel = document.createElement('label');
    searchLabel.className = 'skill-picker-search';
    const searchIcon = document.createElement('i');
    searchIcon.className = 'bx bx-search';
    searchIcon.setAttribute('aria-hidden', 'true');
    const search = document.createElement('input');
    search.type = 'search';
    search.autocomplete = 'off';
    search.spellcheck = false;
    search.placeholder = 'Search skills or type your own…';
    search.setAttribute('aria-label', input.name === 'skills_to_learn' ? 'Search skills you want to learn' : 'Search skills you can teach');
    search.setAttribute('aria-expanded', 'false');
    searchLabel.append(searchIcon, search);

    const popularLabel = document.createElement('div');
    popularLabel.className = 'skill-picker-section-label';
    popularLabel.textContent = 'Fresh choices · 30 at a time';
    const popularHost = document.createElement('div');
    popularHost.className = 'skill-picker-popular';
    popularHost.setAttribute('aria-live', 'polite');

    const suggestionHost = document.createElement('div');
    suggestionHost.className = 'skill-picker-suggestions';
    suggestionHost.setAttribute('role', 'listbox');
    suggestionHost.setAttribute('aria-label', 'Matching skills');

    const helper = document.createElement('p');
    helper.className = 'skill-picker-helper';
    helper.textContent = 'Choose a popular skill, search the list, or type your own and press Enter.';

    // Keep the interaction hierarchy in the same order as the user's intent:
    // search first, matching results immediately below it, and fresh/popular
    // choices only after the search results.
    host.append(selectedHost, searchLabel, suggestionHost, popularLabel, popularHost, helper);

    let selected = [];
    let popularBatch = [];
    const popularSeenKeys = new Set();
    const keyFor = value => normalizeOptionSearch(value);
    const knownSkill = value => {
      const key = keyFor(value);
      return values.skills.find(option => keyFor(option) === key) || String(value || '').trim();
    };
    const isSelected = value => selected.some(item => keyFor(item) === keyFor(value));

    const shuffled = items => {
      const copy = [...items];
      for (let index = copy.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
      }
      return copy;
    };

    const nextFreshSkill = () => {
      const selectedKeys = new Set(selected.map(keyFor));
      const displayedKeys = new Set(popularBatch.map(keyFor));
      const available = skill => {
        const key = keyFor(skill);
        return !selectedKeys.has(key) && !displayedKeys.has(key);
      };
      let candidates = shuffled(values.skills.filter(skill => available(skill) && !popularSeenKeys.has(keyFor(skill))));

      // Once the catalogue has been shown, start a new cycle while still
      // protecting the current batch and selected skills from duplicates.
      if (!candidates.length) {
        popularSeenKeys.clear();
        popularBatch.forEach(skill => popularSeenKeys.add(keyFor(skill)));
        selected.forEach(skill => popularSeenKeys.add(keyFor(skill)));
        candidates = shuffled(values.skills.filter(available));
      }
      return candidates[0] || '';
    };

    const refreshPopularBatch = () => {
      const selectedKeys = new Set(selected.map(keyFor));
      popularBatch = popularBatch.filter(skill => !selectedKeys.has(keyFor(skill)));

      // The first batch keeps a few familiar choices. Later refreshes only
      // fill missing slots and never replace the options already on screen.
      if (!popularBatch.length) {
        const featured = shuffled(popularSkills.filter(skill => !selectedKeys.has(keyFor(skill))));
        featured.slice(0, POPULAR_SKILL_COUNT).forEach(skill => {
          if (!popularBatch.some(item => keyFor(item) === keyFor(skill))) popularBatch.push(skill);
          popularSeenKeys.add(keyFor(skill));
        });
      }
      while (popularBatch.length < POPULAR_SKILL_COUNT) {
        const next = nextFreshSkill();
        if (!next) break;
        popularBatch.push(next);
        popularSeenKeys.add(keyFor(next));
      }
      popularBatch = popularBatch.slice(0, POPULAR_SKILL_COUNT);
    };

    const replacePopularSkill = value => {
      const index = popularBatch.findIndex(skill => keyFor(skill) === keyFor(value));
      if (index < 0) return;
      const replacement = nextFreshSkill();
      if (replacement) {
        popularBatch[index] = replacement;
        popularSeenKeys.add(keyFor(replacement));
      }
    };

    const syncValue = announce => {
      input.value = selected.join(', ');
      if (announce) input.dispatchEvent(new Event('input', {bubbles: true}));
    };

    const removeSkill = value => {
      selected = selected.filter(item => keyFor(item) !== keyFor(value));
      syncValue(true);
      render();
      search.focus();
    };

    const addSkill = value => {
      const cleaned = String(value || '').replace(/^[,;\s]+|[,;\s]+$/g, '').trim();
      if (!cleaned) return false;
      if (isSelected(cleaned)) {
        helper.textContent = `${knownSkill(cleaned)} is already selected.`;
        host.classList.add('has-feedback');
        return false;
      }
      selected.push(knownSkill(cleaned));
      syncValue(true);
      search.value = '';
      host.classList.add('is-open');
      replacePopularSkill(cleaned);
      render();
      search.focus();
      return true;
    };

    const renderSelected = () => {
      selectedHost.replaceChildren();
      if (!selected.length) {
        const empty = document.createElement('span');
        empty.className = 'skill-picker-empty';
        empty.textContent = 'No skills added yet';
        selectedHost.appendChild(empty);
      } else {
        selected.forEach(skill => {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'skill-picker-chip';
          chip.dataset.skillRemove = skill;
          chip.setAttribute('aria-label', `Remove ${skill}`);
          const text = document.createElement('span');
          text.textContent = skill;
          const icon = document.createElement('i');
          icon.className = 'bx bx-x';
          icon.setAttribute('aria-hidden', 'true');
          chip.append(text, icon);
          selectedHost.appendChild(chip);
        });
      }
      const count = document.createElement('span');
      count.className = 'skill-picker-count';
      count.textContent = `${selected.length} selected`;
      selectedHost.appendChild(count);
    };

    const renderPopular = () => {
      if (popularBatch.length < POPULAR_SKILL_COUNT || popularBatch.filter(skill => !isSelected(skill)).length < POPULAR_SKILL_COUNT) {
        refreshPopularBatch();
      }
      popularHost.replaceChildren();
      const available = popularBatch.filter(skill => !isSelected(skill)).slice(0, POPULAR_SKILL_COUNT);
      available.forEach(skill => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.skillAdd = skill;
        button.textContent = `+ ${skill}`;
        popularHost.appendChild(button);
      });
      popularLabel.textContent = `Fresh choices · ${available.length} at a time`;
      popularHost.setAttribute('aria-label', `${available.length} fresh skill options`);
      popularLabel.hidden = popularHost.children.length === 0;
      popularHost.hidden = popularHost.children.length === 0;
    };

    const addSuggestionButton = (label, value, className = '') => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = className;
      button.dataset.skillAdd = value;
      button.setAttribute('role', 'option');
      const icon = document.createElement('i');
      icon.className = className ? 'bx bx-plus-circle' : 'bx bx-check-circle';
      icon.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      text.textContent = label;
      button.append(icon, text);
      suggestionHost.appendChild(button);
    };

    const renderSuggestions = () => {
      suggestionHost.replaceChildren();
      const query = keyFor(search.value);
      if (!query) {
        suggestionHost.classList.remove('has-results');
        search.setAttribute('aria-expanded', 'false');
        return;
      }
      const matches = values.skills.filter(skill => !isSelected(skill) && keyFor(skill).includes(query)).slice(0, 8);
      matches.forEach(skill => addSuggestionButton(skill, skill));
      const exact = matches.some(skill => keyFor(skill) === query) || isSelected(query);
      if (!exact && search.value.trim()) addSuggestionButton(`Add “${search.value.trim()}” as a custom skill`, search.value.trim(), 'is-custom');
      const hasResults = suggestionHost.children.length > 0;
      suggestionHost.classList.toggle('has-results', hasResults);
      search.setAttribute('aria-expanded', String(host.classList.contains('is-open') && hasResults));
    };

    function render() {
      renderSelected();
      renderPopular();
      renderSuggestions();
      host.classList.toggle('has-selections', selected.length > 0);
      host.classList.remove('has-feedback');
      helper.textContent = selected.length ? 'Add more skills whenever you like, or remove one above.' : 'Choose a popular skill, search the list, or type your own and press Enter.';
    }

    const refresh = () => {
      const incoming = splitPickerValues(input.value).map(knownSkill);
      selected = incoming.filter((value, index, items) => items.findIndex(item => keyFor(item) === keyFor(value)) === index);
      refreshPopularBatch();
      render();
    };

    selectedHost.addEventListener('click', event => {
      const button = event.target.closest('[data-skill-remove]');
      if (button) removeSkill(button.dataset.skillRemove);
    });
    popularHost.addEventListener('click', event => {
      const button = event.target.closest('[data-skill-add]');
      if (button) addSkill(button.dataset.skillAdd);
    });
    suggestionHost.addEventListener('click', event => {
      const button = event.target.closest('[data-skill-add]');
      if (button) addSkill(button.dataset.skillAdd);
    });
    search.addEventListener('focus', () => {
      host.classList.add('is-open');
      renderSuggestions();
    });
    search.addEventListener('input', () => {
      host.classList.add('is-open');
      host.classList.remove('has-feedback');
      renderSuggestions();
    });
    search.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ',') {
        event.preventDefault();
        addSkill(search.value);
      } else if (event.key === 'Backspace' && !search.value && selected.length) {
        removeSkill(selected.at(-1));
      } else if (event.key === 'Escape') {
        host.classList.remove('is-open');
        search.setAttribute('aria-expanded', 'false');
      }
    });
    input.addEventListener('change', refresh);
    document.addEventListener('click', event => {
      if (!host.contains(event.target)) {
        host.classList.remove('is-open');
        search.setAttribute('aria-expanded', 'false');
      }
    });

    const controller = {
      refresh,
      focus: () => search.focus(),
      getValues: () => [...selected]
    };
    input.__relaySkillsSkillPicker = controller;
    refresh();
    return controller;
  }

  function setupMultiPicker(input, key) {
    // Skills use the styled menu below. Do not also attach a native datalist:
    // browsers render that second popup with their own theme, which creates
    // two overlapping suggestion lists on dark pages.
    const nativeListId = input.getAttribute('list');
    if (nativeListId) document.getElementById(nativeListId)?.remove();
    input.removeAttribute('list');
    const supportsNothingForNow = key === 'learningLanguages';
    const menu = document.createElement('div');
    menu.className = 'option-suggestion-menu';
    input.parentElement.style.position = 'relative';
    input.insertAdjacentElement('afterend', menu);
    const close = () => menu.classList.remove('open');
    const update = () => {
      const parts = input.value.split(',');
      const currentPart = parts.at(-1).trim();
      const lockedNothing = supportsNothingForNow && parts.length === 1 && currentPart.toLowerCase() === NOTHING_FOR_NOW.toLowerCase();
      const query = lockedNothing ? '' : normalizeOptionSearch(currentPart);
      const selected = new Set(parts.slice(0, -1).map(item => item.trim().toLowerCase()));
      const matches = (values[key] || []).filter(option => {
        const normalized = normalizeOptionSearch(option);
        const rawNormalized = option.toLowerCase();
        if (supportsNothingForNow && rawNormalized === NOTHING_FOR_NOW.toLowerCase()) {
          return !lockedNothing && (!query || normalized.includes(query));
        }
        if (lockedNothing) return true;
        return !selected.has(rawNormalized) && (!query || normalized.includes(query));
      }).slice(0, 10);
      menu.innerHTML = matches.map(option =>
        `<button type="button" data-option-value="${String(option).replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">${String(option).replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</button>`
        ).join('');
      menu.classList.toggle('open', matches.length > 0);
      menu.querySelectorAll('[data-option-value]').forEach(button => button.addEventListener('mousedown', event => {
        event.preventDefault();
        const selectedOption = button.dataset.optionValue;
        if (supportsNothingForNow && selectedOption.toLowerCase() === NOTHING_FOR_NOW.toLowerCase()) {
          input.value = NOTHING_FOR_NOW;
        } else {
          const prefix = parts.slice(0, -1).map(item => item.trim()).filter(item =>
            item && (!supportsNothingForNow || item.toLowerCase() !== NOTHING_FOR_NOW.toLowerCase()));
          input.value = [...prefix, selectedOption].join(', ') + ', ';
        }
        input.dispatchEvent(new Event('input', {
          bubbles: true
        }));
        input.focus();
      }));
    };
    input.addEventListener('focus', update);
    input.addEventListener('input', update);
    input.addEventListener('blur', () => setTimeout(close, 120));
  }

  function initialize(root = document) {
    root.querySelectorAll('[data-country-select]').forEach(setupCountrySelect);
    root.querySelectorAll('[data-country-timezone-select]:not([data-auto-timezone-value])').forEach(setupCountryTimezoneSelect);
    root.querySelectorAll('[data-option-list]').forEach(input => addDatalist(input, input.dataset.optionList));
    root.querySelectorAll('input[name="skills_to_teach"], input[name="skills_to_learn"], input[name="teach_skills"], input[name="learn_skills"]').forEach(input => {
      if (!input.dataset.multiOptions) input.dataset.multiOptions = 'skills';
    });
    root.querySelectorAll('[data-multi-options]').forEach(input => {
      const key = input.dataset.multiOptions;
      if (key === 'skills' && input.dataset.skillPickerUi !== undefined) setupSkillPicker(input);
      else setupMultiPicker(input, key);
    });
    root.querySelectorAll('[data-age-select]').forEach(select => {
      const current = select.value;
      select.innerHTML = '<option value="">Select age</option>' + values.ages.map(age =>
        `<option value="${age}">${age}</option>`).join('');
      if (current) select.value = current;
    });
  }

  function refreshPickers(root = document) {
    root.querySelectorAll('[data-skill-picker-ui]').forEach(input => input.__relaySkillsSkillPicker?.refresh());
  }

  function focusPicker(name, root = document) {
    const input = [...root.querySelectorAll('[data-skill-picker-ui]')].find(item => item.name === name);
    input?.__relaySkillsSkillPicker?.focus();
  }

  window.SwapLabsOptions = {
    values,
    countryCodeForName,
    timezonesForCountry,
    timezoneLabel,
    timezoneForCountry,
    initialize,
    refreshPickers,
    focusPicker
  };
  initialize();
  window.dispatchEvent(new CustomEvent('swaplabs:options-ready'));
})();
