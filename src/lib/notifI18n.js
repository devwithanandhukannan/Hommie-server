/**
 * Server-side notification localization so both stored in-app notifications
 * and Web Push lock-screen alerts render in each recipient's chosen language (en | ml | ta | hi).
 */

const TEMPLATES = {
  grocery_added: {
    en: (p) => {
      const item = p.qty ? `${p.name} (${p.qty})` : p.name;
      return { title: `${p.by} added to grocery list`, body: item, pushBody: item };
    },
    ml: (p) => {
      const item = p.qty ? `${p.name} (${p.qty})` : p.name;
      return { title: `${p.by} പലചരക്ക് ലിസ്റ്റിൽ ചേർത്തു`, body: item, pushBody: item };
    },
    ta: (p) => {
      const item = p.qty ? `${p.name} (${p.qty})` : p.name;
      return { title: `${p.by} மளிகைப் பட்டியலில் சேர்த்தார்`, body: item, pushBody: item };
    },
    hi: (p) => {
      const item = p.qty ? `${p.name} (${p.qty})` : p.name;
      return { title: `${p.by} ने किराना सूची में जोड़ा`, body: item, pushBody: item };
    },
  },
  grocery_batch: {
    en: (p) => ({ title: `${p.by} added ${p.count} grocery items`, body: p.preview, pushBody: p.preview }),
    ml: (p) => ({ title: `${p.by} ${p.count} സാധനങ്ങൾ ലിസ്റ്റിൽ ചേർത്തു`, body: p.preview, pushBody: p.preview }),
    ta: (p) => ({ title: `${p.by} ${p.count} மளிகைப் பொருட்களைச் சேர்த்தார்`, body: p.preview, pushBody: p.preview }),
    hi: (p) => ({ title: `${p.by} ने ${p.count} किराना आइटम जोड़े`, body: p.preview, pushBody: p.preview }),
  },
  medicine_added: {
    en: (p) => ({
      title: `${p.by} added a medicine schedule`,
      body: `${p.forName}: ${p.name} (${p.times})`,
      pushBody: 'Open the app to see the schedule',
    }),
    ml: (p) => ({
      title: `${p.by} മരുന്ന് ഷെഡ്യൂൾ ചേർത്തു`,
      body: `${p.forName}: ${p.name} (${p.times})`,
      pushBody: 'വിവരങ്ങൾ കാണാൻ ആപ്പ് തുറക്കുക',
    }),
    ta: (p) => ({
      title: `${p.by} மருந்து அட்டவணையைச் சேர்த்தார்`,
      body: `${p.forName}: ${p.name} (${p.times})`,
      pushBody: 'விவரங்களைப் பார்க்க செயலியைத் திறக்கவும்',
    }),
    hi: (p) => ({
      title: `${p.by} ने दवा शेड्यूल जोड़ा`,
      body: `${p.forName}: ${p.name} (${p.times})`,
      pushBody: 'विवरण देखने के लिए ऐप खोलें',
    }),
  },
  task_assigned: {
    en: (p) => ({ title: `${p.by} gave you a task`, body: p.title, pushBody: 'Open the app to see it' }),
    ml: (p) => ({ title: `${p.by} നിങ്ങൾക്ക് ഒരു ജോലി തന്നു`, body: p.title, pushBody: 'വിവരങ്ങൾ കാണാൻ ആപ്പ് തുറക്കുക' }),
    ta: (p) => ({ title: `${p.by} உங்களுக்கு ஒரு பணியை அளித்தார்`, body: p.title, pushBody: 'பார்க்க செயலியைத் திறக்கவும்' }),
    hi: (p) => ({ title: `${p.by} ने आपको एक कार्य दिया`, body: p.title, pushBody: 'देखने के लिए ऐप खोलें' }),
  },
  task_open: {
    en: (p) => ({ title: `${p.by} added a task for everyone`, body: p.title, pushBody: 'Open the app to view or claim it' }),
    ml: (p) => ({ title: `${p.by} എല്ലാവർക്കുമായി ഒരു ജോലി ചേർത്തു`, body: p.title, pushBody: 'കാണാനോ ഏറ്റെടുക്കാനോ ആപ്പ് തുറക്കുക' }),
    ta: (p) => ({ title: `${p.by} அனைவருக்கும் ஒரு பணியைச் சேர்த்தார்`, body: p.title, pushBody: 'பார்க்க அல்லது ஏற்க செயலியைத் திறக்கவும்' }),
    hi: (p) => ({ title: `${p.by} ने सभी के लिए एक कार्य जोड़ा`, body: p.title, pushBody: 'देखने या लेने के लिए ऐप खोलें' }),
  },
};

function translateLegacyString(raw, lang) {
  if (!raw || !lang || lang === 'en') return raw;
  const text = String(raw);

  if (lang === 'ml') {
    if (text.includes(': new messages')) return text.replace(': new messages', ': പുതിയ സന്ദേശങ്ങൾ');
    if (text.endsWith(' sent a voice message')) return `${text.replace(/ sent a voice message$/, '')} ഒരു വോയ്സ് മെസ്സേജ് അയച്ചു`;
    if (text.endsWith(' sent an attachment')) return `${text.replace(/ sent an attachment$/, '')} ഒരു ഫയൽ അയച്ചു`;
    if (text.startsWith('Enter the amount for ')) return `${text.slice('Enter the amount for '.length)} - തുക രേഖപ്പെടുത്തുക`;
    const dueMatch = /^(.+) is due (\d{4}-\d{2}-\d{2})$/.exec(text);
    if (dueMatch) return `${dueMatch[1]} അടയ്ക്കാനുള്ള തീയതി: ${dueMatch[2]}`;
    const dueAddMatch = /^Due (\d{4}-\d{2}-\d{2})\. Open the app to add the amount\.$/.exec(text);
    if (dueAddMatch) return `തീയതി: ${dueAddMatch[1]}. തുക ചേർക്കാൻ ആപ്പ് തുറക്കുക.`;
    const duePlainMatch = /^Due (\d{4}-\d{2}-\d{2})\.?$/.exec(text);
    if (duePlainMatch) return `തീയതി: ${duePlainMatch[1]}`;
    if (text.endsWith(' gave you a task')) return `${text.replace(/ gave you a task$/, '')} നിങ്ങൾക്ക് ഒരു ജോലി തന്നു`;
    if (text === 'Medicine time') return 'മരുന്ന് കഴിക്കേണ്ട സമയം';
    if (text === 'Medicine running low') return 'മരുന്ന് തീരാറായി';
    const doseMatch = /^Dose due at (.+)$/.exec(text);
    if (doseMatch) return `മരുന്ന് സമയം: ${doseMatch[1]}`;
    if (text.endsWith(' is due today')) return `${text.replace(/ is due today$/, '')} ഇന്ന് അടയ്ക്കണം`;
    if (text.endsWith(' is due tomorrow')) return `${text.replace(/ is due tomorrow$/, '')} നാളെ അടയ്ക്കണം`;
    if (text.endsWith(' is overdue')) return `${text.replace(/ is overdue$/, '')} അടയ്ക്കാനുള്ള കാലാവധി കഴിഞ്ഞു`;
    if (text === 'A document expires today') return 'ഒരു രേഖയുടെ കാലാവധി ഇന്ന് തീരുന്നു';
    const docExp = /^A document expires in (\d+) days?$/.exec(text);
    if (docExp) return `ഒരു രേഖയുടെ കാലാവധി ${docExp[1]} ദിവസത്തിനുള്ളിൽ തീരും`;
    if (text === 'A loan EMI is coming up') return 'ലോൺ ഇഎംഐ അടയ്ക്കാനുണ്ട്';
    if (text.startsWith('Today: ')) return `ഇന്ന്: ${text.slice('Today: '.length)}`;
    const inDays = /^(.+) in (\d+) days?$/.exec(text);
    if (inDays) return `${inDays[1]} ${inDays[2]} ദിവസത്തിൽ`;
    if (text === 'Amount still needed') return 'തുക ചേർക്കേണ്ടതുണ്ട്';
    if (text.startsWith('Amount ')) return text.replace('Amount ', 'തുക ');
    if (text.startsWith('It was due on ')) return text.replace('It was due on ', 'അടയ്ക്കാനുള്ള തീയതി: ');
    if (text.startsWith('Open the app')) return 'വിവരങ്ങൾ കാണാൻ ആപ്പ് തുറക്കുക';
    if (text.endsWith(' left')) return text.replace(/ left$/, ' ബാക്കി');
    if (text.includes(' at ')) return text.replace(' at ', ' സമയം: ');
    return text;
  }

  if (lang === 'ta') {
    if (text.includes(': new messages')) return text.replace(': new messages', ': புதிய செய்திகள்');
    if (text.endsWith(' sent a voice message')) return `${text.replace(/ sent a voice message$/, '')} ஒரு குரல் செய்தியை அனுப்பியுள்ளார்`;
    if (text.endsWith(' sent an attachment')) return `${text.replace(/ sent an attachment$/, '')} ஒரு இணைப்பை அனுப்பியுள்ளார்`;
    if (text.startsWith('Enter the amount for ')) return `${text.slice('Enter the amount for '.length)} - தொகையை உள்ளிடவும்`;
    const dueMatch = /^(.+) is due (\d{4}-\d{2}-\d{2})$/.exec(text);
    if (dueMatch) return `${dueMatch[1]} செலுத்த வேண்டிய தேதி: ${dueMatch[2]}`;
    const dueAddMatch = /^Due (\d{4}-\d{2}-\d{2})\. Open the app to add the amount\.$/.exec(text);
    if (dueAddMatch) return `தேதி: ${dueAddMatch[1]}. தொகையைச் சேர்க்க செயலியைத் திறக்கவும்.`;
    const duePlainMatch = /^Due (\d{4}-\d{2}-\d{2})\.?$/.exec(text);
    if (duePlainMatch) return `தேதி: ${duePlainMatch[1]}`;
    if (text.endsWith(' gave you a task')) return `${text.replace(/ gave you a task$/, '')} உங்களுக்கு ஒரு பணியை அளித்தார்`;
    if (text === 'Medicine time') return 'மருந்து நேரம்';
    if (text === 'Medicine running low') return 'மருந்து குறைகிறது';
    const doseMatch = /^Dose due at (.+)$/.exec(text);
    if (doseMatch) return `மருந்து நேரம்: ${doseMatch[1]}`;
    if (text.endsWith(' is due today')) return `${text.replace(/ is due today$/, '')} இன்று செலுத்த வேண்டும்`;
    if (text.endsWith(' is due tomorrow')) return `${text.replace(/ is due tomorrow$/, '')} நாளை செலுத்த வேண்டும்`;
    if (text.endsWith(' is overdue')) return `${text.replace(/ is overdue$/, '')} செலுத்த வேண்டிய காலம் கடந்துவிட்டது`;
    if (text === 'A document expires today') return 'ஒரு ஆவணம் இன்று காலாவதியாகிறது';
    const docExp = /^A document expires in (\d+) days?$/.exec(text);
    if (docExp) return `ஒரு ஆவணம் ${docExp[1]} நாட்களில் காலாவதியாகிறது`;
    if (text === 'A loan EMI is coming up') return 'கடன் இஎம்ஐ வரவிருக்கிறது';
    if (text.startsWith('Today: ')) return `இன்று: ${text.slice('Today: '.length)}`;
    const inDays = /^(.+) in (\d+) days?$/.exec(text);
    if (inDays) return `${inDays[1]} ${inDays[2]} நாட்களில்`;
    if (text === 'Amount still needed') return 'தொகை தேவைப்படுகிறது';
    if (text.startsWith('Amount ')) return text.replace('Amount ', 'தொகை ');
    if (text.startsWith('It was due on ')) return text.replace('It was due on ', 'செலுத்த வேண்டிய தேதி: ');
    if (text.startsWith('Open the app')) return 'பார்க்க செயலியைத் திறக்கவும்';
    if (text.endsWith(' left')) return text.replace(/ left$/, ' மீதமுள்ளது');
    if (text.includes(' at ')) return text.replace(' at ', ' நேரம்: ');
    return text;
  }

  if (lang === 'hi') {
    if (text.includes(': new messages')) return text.replace(': new messages', ': नए संदेश');
    if (text.endsWith(' sent a voice message')) return `${text.replace(/ sent a voice message$/, '')} ने एक वॉइस संदेश भेजा`;
    if (text.endsWith(' sent an attachment')) return `${text.replace(/ sent an attachment$/, '')} ने एक फ़ाइल भेजी`;
    if (text.startsWith('Enter the amount for ')) return `${text.slice('Enter the amount for '.length)} - राशि दर्ज करें`;
    const dueMatch = /^(.+) is due (\d{4}-\d{2}-\d{2})$/.exec(text);
    if (dueMatch) return `${dueMatch[1]} देय तिथि: ${dueMatch[2]}`;
    const dueAddMatch = /^Due (\d{4}-\d{2}-\d{2})\. Open the app to add the amount\.$/.exec(text);
    if (dueAddMatch) return `देय तिथि: ${dueAddMatch[1]}. राशि जोड़ने के लिए ऐप खोलें।`;
    const duePlainMatch = /^Due (\d{4}-\d{2}-\d{2})\.?$/.exec(text);
    if (duePlainMatch) return `देय तिथि: ${duePlainMatch[1]}`;
    if (text.endsWith(' gave you a task')) return `${text.replace(/ gave you a task$/, '')} ने आपको एक कार्य दिया`;
    if (text === 'Medicine time') return 'दवा लेने का समय';
    if (text === 'Medicine running low') return 'दवा खत्म होने वाली है';
    const doseMatch = /^Dose due at (.+)$/.exec(text);
    if (doseMatch) return `दवा का समय: ${doseMatch[1]}`;
    if (text.endsWith(' is due today')) return `${text.replace(/ is due today$/, '')} आज देय है`;
    if (text.endsWith(' is due tomorrow')) return `${text.replace(/ is due tomorrow$/, '')} कल देय है`;
    if (text.endsWith(' is overdue')) return `${text.replace(/ is overdue$/, '')} की तिथि निकल गई है`;
    if (text === 'A document expires today') return 'एक दस्तावेज़ आज समाप्त हो रहा है';
    const docExp = /^A document expires in (\d+) days?$/.exec(text);
    if (docExp) return `एक दस्तावेज़ ${docExp[1]} दिनों में समाप्त होगा`;
    if (text === 'A loan EMI is coming up') return 'लोन EMI आने वाली है';
    if (text.startsWith('Today: ')) return `आज: ${text.slice('Today: '.length)}`;
    const inDays = /^(.+) in (\d+) days?$/.exec(text);
    if (inDays) return `${inDays[1]} ${inDays[2]} दिनों में`;
    if (text === 'Amount still needed') return 'राशि दर्ज करना बाकी है';
    if (text.startsWith('Amount ')) return text.replace('Amount ', 'राशि ');
    if (text.startsWith('It was due on ')) return text.replace('It was due on ', 'देय तिथि थी: ');
    if (text.startsWith('Open the app')) return 'देखने के लिए ऐप खोलें';
    if (text.endsWith(' left')) return text.replace(/ left$/, ' शेष');
    if (text.includes(' at ')) return text.replace(' at ', ' समय: ');
    return text;
  }

  return text;
}

/**
 * Resolves notification title, body, pushTitle, pushBody in the recipient user's chosen language.
 */
export function renderNotification({ i18nKey, params = {}, title, body, pushTitle, pushBody }, lang = 'en') {
  const code = ['en', 'ml', 'ta', 'hi'].includes(lang) ? lang : 'en';
  if (i18nKey && TEMPLATES[i18nKey]) {
    const fn = TEMPLATES[i18nKey][code] || TEMPLATES[i18nKey].en;
    const out = fn(params || {});
    return {
      title: String(out.title || '').slice(0, 140),
      body: out.body != null ? String(out.body).slice(0, 300) : '',
      pushTitle: String(out.pushTitle || out.title || '').slice(0, 140),
      pushBody: out.pushBody != null ? String(out.pushBody).slice(0, 300) : String(out.body || '').slice(0, 300),
    };
  }

  const locTitle = translateLegacyString(title, code);
  const locBody = body != null ? translateLegacyString(body, code) : undefined;
  const locPushTitle = pushTitle ? translateLegacyString(pushTitle, code) : locTitle;
  const locPushBody = pushBody != null ? translateLegacyString(pushBody, code) : locBody ?? '';

  return {
    title: String(locTitle || '').slice(0, 140),
    body: locBody != null ? String(locBody).slice(0, 300) : undefined,
    pushTitle: String(locPushTitle || '').slice(0, 140),
    pushBody: String(locPushBody || '').slice(0, 300),
  };
}

