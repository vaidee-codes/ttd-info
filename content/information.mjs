// Reviewed editorial data. Dates are civil dates in Asia/Kolkata, never inferred recurrences.
export const reviewed = '2026-09-10';
export const origin = 'https://ttd-info.vercel.app';
export const sources = {
  calendar: {title:'The Tirumala Verse · event topics',url:'https://thetirumalaverse.in/',kind:'Reference'},
  glossary: {title:'The Tirumala Verse · glossary',url:'https://thetirumalaverse.in/glossary',kind:'Reference'},
  sevas: {title:'The Tirumala Verse · seva topics',url:'https://thetirumalaverse.in/sevas',kind:'Reference'},
  tokens: {title:'The Tirumala Verse · token guidance',url:'https://thetirumalaverse.in/tokens',kind:'Community reference; operational details need confirmation'},
  daily: {title:'TTD · daily sevas',url:'https://www.tirumala.org/DailySevas.aspx',kind:'Official reference schedule; check ticket instructions'},
  weekly: {title:'TTD · weekly sevas',url:'https://www.tirumala.org/WeeklySevas.aspx',kind:'Official reference schedule; check ticket instructions'},
  annual: {title:'TTD · 2026 Brahmotsavam announcement',url:'https://news.tirumala.org/srivari-annual-brahmotsavams-from-september-15-to-23-_-%E0%B0%B8%E0%B1%86%E0%B0%AA%E0%B1%8D%E0%B0%9F%E0%B1%86%E0%B0%82%E0%B0%AC%E0%B0%B0%E0%B1%8D-15-%E0%B0%A8%E0%B1%81%E0%B0%82%E0%B0%A1%E0%B0%BF-23/',kind:'Official announcement'},
  padma: {title:'TTD · Tiruchanoor September festivals',url:'https://news.tirumala.org/%E0%B0%B8%E0%B1%86%E0%B0%AA%E0%B1%8D%E0%B0%9F%E0%B1%86%E0%B0%82%E0%B0%AC%E0%B0%B0%E0%B1%81%E0%B0%B2%E0%B1%8B-%E0%B0%B6%E0%B1%8D%E0%B0%B0%E0%B1%80-%E0%B0%AA%E0%B0%A6%E0%B1%8D%E0%B0%AE%E0%B0%BE%E0%B0%B5/',kind:'Official announcement'},
  booking: {title:'Official TTD booking portal',url:'https://ttdevasthanams.ap.gov.in/',kind:'Official booking and ticket instructions'},
  liveOfficial: {title:'TTD homepage · current SSD status',url:'https://www.tirumala.org/Home.aspx',kind:'Official SSD slot, date and balance'},
  liveCommunity: {title:'Tirumala Info · community live status',url:'https://tirumalainfo.com/tirumala-live-status.php',kind:'Independent community report (verify on the ground)'}
};
export const temples = [
 ['tirumala','Sri Venkateswara Swamy · Tirumala'],['tiruchanoor','Sri Padmavathi Ammavari · Tiruchanoor'],
 ['govindaraja','Sri Govindaraja Swamy · Tirupati'],['kapileswara','Sri Kapileswara Swamy · Tirupati'],
 ['srinivasa-mangapuram','Sri Kalyana Venkateswara · Srinivasa Mangapuram'],['narayanavanam','Sri Kalyana Venkateswara · Narayanavanam'],
 ['kodandarama','Sri Kodandarama Swamy · Tirupati'],['appalayagunta','Sri Prasanna Venkateswara · Appalayagunta']
];
const festivalDays = [
 ['14','Ankurarpanam','Evening · festival preparations'],
 ['15','Dwajarohanam & Pedda Sesha Vahanam','Evening flag ceremony · procession 9 pm'],
 ['16','Chinna Sesha & Hamsa Vahanam','8 am / 7 pm · Snapanam 1–3 pm'],
 ['17','Simha & Mutyapu Pandiri Vahanam','8 am / 7 pm'],
 ['18','Kalpavriksha & Sarva Bhoopala Vahanam','8 am / 7 pm'],
 ['19','Mohini Avataram & Garuda Vahanam','8 am · Garuda 6:30–11:30 pm'],
 ['20','Hanumantha & Gaja Vahanam','8 am / 7 pm · Swarna Ratham 4 pm'],
 ['21','Suryaprabha & Chandraprabha Vahanam','8 am / 7 pm · Snapanam 1–3 pm'],
 ['22','Rathotsavam & Aswa Vahanam','7 am / 7 pm'],
 ['23','Chakrasnanam & Dwajavarohanam','6–9 am · flag lowering at night']
];
export const events = [
 ...festivalDays.map(([day,title,time])=>({id:`brahmotsavam-${day}`,date:`2026-09-${day}`,temple:'tirumala',title,time,source:'annual',term:'brahmotsavam'})),
 {id:'navaratri-2026',date:'2026-10-12',endDate:'2026-10-20',temple:'tirumala',title:'Navarathri Brahmotsavams',time:'Festival date range · consult TTD for daily timings',source:'annual',term:'brahmotsavam'},
 ...['04','11','18','25'].map(day=>({id:`padma-${day}`,date:`2026-09-${day}`,temple:'tiruchanoor',title:'Ammavaru Tiruchi procession',time:'6 pm · four Mada streets',source:'padma',term:'vahanam'})),
 {id:'padma-gaja',date:'2026-09-22',temple:'tiruchanoor',title:'Ammavaru Gaja Vahanam',time:'6:45 pm · Uttarashada Nakshatram',source:'padma',term:'gaja-vahanam'}
].sort((a,b)=>a.date.localeCompare(b.date)||a.title.localeCompare(b.title));
export const sevas = [
 ['suprabhatam','Daily','All days','Suprabhatam','03:00–03:30 hrs','Awakening prayers begin the daily worship.','daily'],
 ['thomala','Daily','All days','Thomala Seva','03:30–04:00 hrs','Garlands are offered to the deity.','daily'],
 ['koluvu','Daily','All days','Koluvu & Panchanga Sravanam','04:00–04:15 hrs','The temple court and almanac reading.','daily'],
 ['archana','Daily','All days','First Archana (Sahasranama Archana)','04:15–05:00 hrs','Worship through the recitation of divine names.','daily'],
 ['kalyanotsavam','Daily','All days','Kalyanotsavam · Brahmotsavam · Unjal Seva','12:00–17:00 hrs','The daytime arjitha-seva window listed in the TTD daily schedule.','daily'],
 ['deepalankarana','Daily','All days','Sahasra Deepalankarana Seva','17:00–17:30 hrs','A lamp-lit worship service.','daily'],
 ['ekanta','Daily','All days','Ekanta Seva','01:30 hrs (Mon–Thu; Sat–Sun) · 22:30 hrs (Fri)','The concluding service of the temple day.','daily'],
 ['ashtadala','Weekly','Tuesday','Ashtadala Pada Padmaradhana','Reporting 05:00 hrs · Seva 06:00 hrs · ₹1,250','Worship associated with golden lotus offerings.','weekly'],
 ['tiruppavada','Weekly','Thursday','Tiruppavada Seva','Reporting 05:00 hrs · Seva 06:15 hrs · ₹850','A special food offering before the deity.','weekly'],
 ['poolangi','Weekly','Thursday','Poolangi Seva','19:00–20:00 hrs','A Thursday evening decoration service.','daily'],
 ['abhishekam','Weekly','Friday','Abhishekam','Reporting 03:00 hrs · Seva 03:30 hrs · ₹750','Ritual bathing of the main deity.','weekly'],
 ['vastralankara','Weekly','Friday','Vastralankara Seva','03:00–03:30 hrs · ₹12,250 · 2 persons','A Friday service associated with Abhishekam.','weekly'],
 ['brahmotsavam','Periodical','Annual','Brahmotsavam','08:00–10:00 hrs and 19:00–21:00 hrs on festival days','A multi-day celebration with temple processions.','annual'],
 ['vasanthotsavam','Periodical','March / April','Vasanthotsavam','13:00 hrs · three days · ₹300','A springtime temple celebration. Confirm the annual notice.','annual'],
 ['teppotsavam','Periodical','Five days each year','Teppotsavam','18:00 hrs · five days · ₹500 per day','A float festival on the temple tank.','annual'],
 ['pavithrotsavam','Periodical','August','Pavithrotsavam','08:00 hrs · three days · ₹2,500','A festival of ritual purification.','annual'],
 ['pushpayagam','Periodical','Annual notice','Pushpa Yagam','13:00–17:00 hrs (2025 official notice)','Worship through offerings of flowers. Confirm the current annual notice.','annual']
].map(([id,category,when,title,timeLabel,description,source])=>({id,category,when,title,timeLabel,description,source}));

export const dailyTimings = [
 {day:'Monday',entries:[['03:00–03:30','Suprabhatam'],['03:30–04:00','Thomala Seva'],['04:00–04:15','Koluvu & Panchanga Sravanam'],['04:15–05:00','First Archana'],['07:00–19:00','Darshanam'],['12:00–17:00','Kalyanotsavam, Brahmotsavam, Unjal Seva'],['17:00–17:30','Sahasra Deepalankarana'],['20:00–01:00','Darshanam'],['01:30','Ekanta Seva']]},
 {day:'Tuesday',entries:[['03:00–03:30','Suprabhatam'],['03:30–04:00','Thomala Seva'],['04:00–05:00','Koluvu, Panchanga & First Archana'],['06:00–07:00','Ashtadala Pada Padmaradhana'],['07:00–19:00','Darshanam'],['12:00–17:00','Kalyanotsavam, Brahmotsavam, Unjal Seva'],['17:00–17:30','Sahasra Deepalankarana'],['20:00–01:00','Darshanam'],['01:30','Ekanta Seva']]},
 {day:'Wednesday',entries:[['03:00–03:30','Suprabhatam'],['03:30–04:00','Thomala Seva'],['04:00–05:00','Koluvu, Panchanga & First Archana'],['06:00–08:00','Second Archana & Bell'],['09:30–19:00','Darshanam'],['12:00–17:00','Kalyanotsavam, Brahmotsavam, Unjal Seva'],['17:00–17:30','Sahasra Deepalankarana'],['20:00–01:00','Darshanam'],['01:30','Ekanta Seva']]},
 {day:'Thursday',entries:[['03:00–05:00','Suprabhatam, Thomala, Koluvu & Archana'],['06:00–07:00','Tiruppavada and Second Bell'],['08:00–19:00','Darshanam'],['12:00–17:00','Kalyanotsavam, Brahmotsavam, Unjal Seva'],['17:00–17:30','Sahasra Deepalankarana'],['19:00–20:00','Poolangi Seva'],['20:00–01:00','Darshanam'],['01:30','Ekanta Seva']]},
 {day:'Friday',entries:[['03:00–03:30','Suprabhata'],['03:30–04:30','Suddhi and morning preparations'],['04:30–06:00','Abhishekam'],['06:00–07:00','Samarpana'],['07:00–08:00','Thomala & Archana'],['09:00–20:00','Darshanam'],['12:00–17:00','Kalyanotsavam, Brahmotsavam, Unjal Seva'],['17:00–17:30','Sahasra Deepalankarana'],['21:00–22:00','Darshanam'],['22:30','Ekanta Seva']]},
 {day:'Saturday & Sunday',entries:[['03:00–04:15','Suprabhata, Thomala, Koluvu & Archana'],['06:30–07:00','First Bell, Bali & Sattumora'],['07:00–07:30','Suddhi, Second Archana & Bell'],['07:30–19:00','Darshanam'],['12:00–17:00','Kalyanotsavam, Brahmotsavam, Unjal Seva'],['17:00–17:30','Sahasra Deepalankarana'],['20:00–01:00','Darshanam'],['01:30','Ekanta Seva']]}
];
export const glossary = [
 ['abhishekam','Abhishekam','అభిషేకం','Rituals','Ritual bathing of a deity.','weekly'],
 ['alankaram','Alankaram','అలంకారం','Rituals','Sacred decoration.','glossary'],
 ['ankurarpanam','Ankurarpanam','అంకురార్పణ','Rituals','Ceremonial sowing before a festival.','glossary'],
 ['archana','Archana','అర్చన','Rituals','Worship by reciting divine names.','daily'],
 ['aswa-vahanam','Aswa Vahanam','','Processions','Horse vehicle.','glossary'],
 ['brahmotsavam','Brahmotsavam','బ్రహ్మోత్సవం','Festivals','A major temple festival with processions across several days.','annual'],
 ['chakra-snanam','Chakra Snanam','చక్రస్నానం','Rituals','Ceremonial bathing of the sacred discus.','glossary'],
 ['chandra-prabha','Chandra Prabha','','Processions','Moon vehicle.','glossary'],
 ['divya-darshan','Divya Darshan (DD)','','Planning','Darshan arrangements associated with a prescribed walking route; follow current token instructions.','tokens'],
 ['dwajarohanam','Dwajarohanam','','Rituals','Festival flag raising.','glossary'],
 ['ekanta','Ekanta Seva','','Rituals','The temple’s closing worship service.','daily'],
 ['gaja-vahanam','Gaja Vahanam','','Processions','Elephant vehicle.','glossary'],
 ['garuda-vahanam','Garuda Vahanam','','Processions','Procession on Garuda.','glossary'],
 ['hamsa-vahanam','Hamsa Vahanam','','Processions','Swan vehicle.','glossary'],
 ['kalyanotsavam','Kalyanotsavam','కల్యాణోత్సవం','Rituals','The ceremonial wedding seva.','daily'],
 ['panchangam','Panchangam','పంచాంగం','Planning','Traditional calendar and almanac.','glossary'],
 ['pavithrotsavam','Pavithrotsavam','','Festivals','Ritual purification festival.','glossary'],
 ['pushpayagam','Pushpa Yagam','','Rituals','Worship with flowers.','glossary'],
 ['rathotsavam','Rathotsavam','రథోత్సవం','Processions','Chariot procession.','glossary'],
 ['ssd','Slotted Sarva Darshan (SSD)','','Planning','Free darshan with an assigned reporting slot, subject to token availability.','tokens'],
 ['snapana','Snapana Tirumanjanam','','Rituals','Ceremonial bathing of processional deities.','glossary'],
 ['suprabhatam','Suprabhatam','సుప్రభాతం','Rituals','Prayers that open the daily worship.','daily'],
 ['surya-prabha','Surya Prabha','','Processions','Sun vehicle.','glossary'],
 ['pushkarini','Swami Pushkarini','స్వామి పుష్కరిణి','Planning','The sacred tank beside the temple.','glossary'],
 ['teppotsavam','Teppotsavam','తెప్పోత్సవం','Festivals','Float festival.','glossary'],
 ['thomala','Thomala Seva','','Rituals','Garland offering during daily worship.','daily'],
 ['unjal','Unjal Seva (Dolotsavam)','','Rituals','A swing service for the deities.','daily'],
 ['vahanam','Vahanam','వాహనం','Processions','A ceremonial vehicle carrying a deity.','glossary'],
 ['vasanthotsavam','Vasanthotsavam','','Festivals','Spring festival.','glossary']
].map(([id,title,telugu,category,description,source])=>({id,title,telugu,category,description,source}));
export const counters = [
 {title:'Srinivasam',area:'Near Tirupati bus stand',type:'SSD reference location',map:'https://maps.app.goo.gl/sJ2HpFbn9Mnz7Pw16'},
 {title:'Vishnu Nivasam',area:'Opposite Tirupati railway station',type:'SSD reference location',map:'https://maps.app.goo.gl/ESc8dYiH5siXjVVS8'},
 {title:'Bhudevi Complex',area:'Near Alipiri',type:'SSD / DD reference location',map:'https://maps.app.goo.gl/GF1MLA6nNeSz6UqN9'}
];
