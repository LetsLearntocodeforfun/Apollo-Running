// World Marathon Majors + popular marathon course database.

import type { MarathonRace, ElevationPoint, CourseSplit, AidStation } from '../types/raceStrategy';

// ═══════════════════════════════════════════════════════════════
//  TOKYO MARATHON — March 1, 2026
// ═══════════════════════════════════════════════════════════════

const TOKYO: MarathonRace = {
  id: 'tokyo-marathon-2026',
  name: 'Tokyo Marathon',
  city: 'Tokyo',
  country: 'Japan',
  category: 'world-major',
  date: '2026-03-01',
  typicalMonth: 3,
  distanceMi: 26.2,
  courseType: 'point-to-point',
  typicalTempF: { low: 38, high: 52 },
  typicalHumidity: 55,
  website: 'https://www.marathon.tokyo',
  startTime: '9:10 AM JST',
  timeLimitHours: 7,
  fieldSize: 38000,
  isWorldMajor: true,
  year: 2026,
  courseDescription:
    'Starting at the Tokyo Metropolitan Government Building in Shinjuku, the course winds through the heart of Tokyo past iconic landmarks including the Imperial Palace, Tokyo Tower, Ginza, and Asakusa\'s Sensoji Temple before finishing at Tokyo Station. One of the flattest and fastest World Major courses.',
  qualifyingInfo:
    'Entry via lottery (general), championship entry with qualifying times, or charity entry. Lottery acceptance rate ~10%.',
  tips: [
    'Extremely flat — one of the best World Major courses for a PR attempt.',
    'March weather can be cool and rainy; pack a throwaway layer for the start.',
    'Crowd support is massive and respectful — bowing spectators are common.',
    'Aid stations are extremely well-organized with water, sports drink, and food.',
    'Arrive at the start early — security is thorough and lines can be long.',
    'The final miles along the waterfront can have headwind off Tokyo Bay.',
  ],
  course: {
    totalGainFt: 135,
    totalLossFt: 171,
    netChangeFt: -36,
    highPointFt: 131,
    lowPointFt: 10,
    difficulty: 2,
    bqFriendly: true,
    prFriendly: true,
    elevationPoints: [
      { distanceMi: 0, elevationFt: 131, landmark: 'Tokyo Metro Gov Building (Start)' },
      { distanceMi: 2, elevationFt: 100 },
      { distanceMi: 3, elevationFt: 65, landmark: 'Iidabashi' },
      { distanceMi: 5, elevationFt: 33, landmark: 'Imperial Palace' },
      { distanceMi: 7, elevationFt: 25 },
      { distanceMi: 9, elevationFt: 30, landmark: 'Shinagawa turnaround' },
      { distanceMi: 10, elevationFt: 22 },
      { distanceMi: 13.1, elevationFt: 18, landmark: 'Half marathon point' },
      { distanceMi: 15, elevationFt: 20, landmark: 'Ginza' },
      { distanceMi: 17, elevationFt: 15 },
      { distanceMi: 19, elevationFt: 12, landmark: 'Asakusa / Sensoji Temple' },
      { distanceMi: 21, elevationFt: 15 },
      { distanceMi: 23, elevationFt: 14 },
      { distanceMi: 25, elevationFt: 12 },
      { distanceMi: 26.2, elevationFt: 10, landmark: 'Tokyo Station (Finish)' },
    ],
  },
  splits: buildEvenSplits(26, 'Flat urban roads', [
    { mile: 1, landmarks: ['Shinjuku'], terrain: 'Gentle downhill through Shinjuku' },
    { mile: 3, landmarks: ['Iidabashi'], terrain: 'Downhill toward river level' },
    { mile: 5, landmarks: ['Imperial Palace'], terrain: 'Flat, scenic palace grounds' },
    { mile: 9, landmarks: ['Shinagawa turnaround'], terrain: 'Flat, turnaround point' },
    { mile: 13, landmarks: ['Ginza district'], terrain: 'Flat through shopping district' },
    { mile: 17, landmarks: ['Nihombashi'], terrain: 'Flat through historic district' },
    { mile: 19, landmarks: ['Asakusa', 'Sensoji Temple'], terrain: 'Flat, huge crowd support' },
    { mile: 22, landmarks: ['Tsukiji area'], terrain: 'Flat, heading toward finish' },
    { mile: 25, landmarks: ['Approaching Tokyo Station'], terrain: 'Flat, final stretch along Gyoko-dori' },
  ]),
  aidStations: buildAidStations([5, 7.5, 10, 12.5, 15, 17.5, 20, 22, 24], ['water', 'sports drink', 'banana', 'bread']),
};

// ═══════════════════════════════════════════════════════════════
//  BOSTON MARATHON — April 20, 2026
// ═══════════════════════════════════════════════════════════════

const BOSTON: MarathonRace = {
  id: 'boston-marathon-2026',
  name: 'Boston Marathon',
  city: 'Boston',
  country: 'United States',
  category: 'world-major',
  date: '2026-04-20',
  typicalMonth: 4,
  distanceMi: 26.2,
  courseType: 'point-to-point',
  typicalTempF: { low: 42, high: 62 },
  typicalHumidity: 55,
  website: 'https://www.baa.org',
  startTime: '10:00 AM ET (Wave 1)',
  timeLimitHours: 6,
  fieldSize: 30000,
  isWorldMajor: true,
  year: 2026,
  courseDescription:
    'The world\'s oldest annual marathon. A legendary point-to-point course from Hopkinton to Copley Square in downtown Boston. Net downhill (480 ft drop) but deceptively challenging with the infamous Newton Hills (miles 16-21) including Heartbreak Hill at mile 20.5. The early downhill tempts runners into pacing mistakes that punish them on the hills.',
  qualifyingInfo:
    'Qualifying times required (age/gender graded). BQ times range from 3:00 (M 18-34) to 5:25 (F 80+). Typically need to beat BQ by 5+ minutes due to demand.',
  tips: [
    'DO NOT bank time on the early downhill — it will cost you on the Newton Hills.',
    'The first 16 miles are net downhill and deceptively easy. Show discipline.',
    'Heartbreak Hill (mile 20.5) is not the steepest hill, but it comes when you\'re fatigued.',
    'The Newton Hills are really 4 hills from mile 16-21. Budget energy for all of them.',
    'Crowds at Wellesley ("The Scream Tunnel") at mile 12 are electric — don\'t surge.',
    'Point-to-point means tailwind is your friend, headwind is brutal. Check forecast.',
    'April weather in Boston is unpredictable — prepare for anything from 35°F to 75°F.',
    'The final downhill mile to Boylston Street is one of running\'s great finishes.',
  ],
  course: {
    totalGainFt: 780,
    totalLossFt: 1260,
    netChangeFt: -480,
    highPointFt: 490,
    lowPointFt: 10,
    difficulty: 7,
    bqFriendly: false,
    prFriendly: false,
    elevationPoints: [
      { distanceMi: 0, elevationFt: 490, landmark: 'Hopkinton (Start)' },
      { distanceMi: 1, elevationFt: 440 },
      { distanceMi: 2, elevationFt: 380 },
      { distanceMi: 3, elevationFt: 320 },
      { distanceMi: 4, elevationFt: 290, landmark: 'Ashland' },
      { distanceMi: 5, elevationFt: 250 },
      { distanceMi: 6, elevationFt: 230 },
      { distanceMi: 7, elevationFt: 200, landmark: 'Framingham' },
      { distanceMi: 8, elevationFt: 175 },
      { distanceMi: 9, elevationFt: 150 },
      { distanceMi: 10, elevationFt: 140 },
      { distanceMi: 11, elevationFt: 125 },
      { distanceMi: 12, elevationFt: 120, landmark: 'Wellesley — Scream Tunnel' },
      { distanceMi: 13, elevationFt: 130 },
      { distanceMi: 13.1, elevationFt: 130, landmark: 'Half marathon' },
      { distanceMi: 14, elevationFt: 120 },
      { distanceMi: 15, elevationFt: 110 },
      { distanceMi: 16, elevationFt: 75, landmark: 'Newton Lower Falls' },
      { distanceMi: 17, elevationFt: 160, landmark: 'Newton Hill #1' },
      { distanceMi: 18, elevationFt: 130 },
      { distanceMi: 19, elevationFt: 180, landmark: 'Newton Hill #2' },
      { distanceMi: 20, elevationFt: 165, landmark: 'Newton Hill #3' },
      { distanceMi: 20.5, elevationFt: 260, landmark: 'Heartbreak Hill summit' },
      { distanceMi: 21, elevationFt: 240, landmark: 'Boston College' },
      { distanceMi: 22, elevationFt: 150 },
      { distanceMi: 23, elevationFt: 80, landmark: 'Brookline' },
      { distanceMi: 24, elevationFt: 50 },
      { distanceMi: 25, elevationFt: 30, landmark: 'Kenmore Square / Citgo sign' },
      { distanceMi: 25.5, elevationFt: 20, landmark: 'Right on Hereford' },
      { distanceMi: 26, elevationFt: 15, landmark: 'Left on Boylston' },
      { distanceMi: 26.2, elevationFt: 10, landmark: 'Copley Square (Finish)' },
    ],
  },
  splits: [
    { number: 1, endMi: 1, elevationChangeFt: -50, terrain: 'Steep downhill — resist the urge to fly', landmarks: ['Hopkinton start'] },
    { number: 2, endMi: 2, elevationChangeFt: -60, terrain: 'Continued downhill', landmarks: [] },
    { number: 3, endMi: 3, elevationChangeFt: -60, terrain: 'Rolling downhill into Ashland', landmarks: [] },
    { number: 4, endMi: 4, elevationChangeFt: -30, terrain: 'Gentle descent', landmarks: ['Ashland center'] },
    { number: 5, endMi: 5, elevationChangeFt: -40, terrain: 'Downhill continues', landmarks: [] },
    { number: 6, endMi: 6, elevationChangeFt: -20, terrain: 'Gradually flattening', landmarks: [] },
    { number: 7, endMi: 7, elevationChangeFt: -30, terrain: 'Into Framingham', landmarks: ['Framingham train depot'] },
    { number: 8, endMi: 8, elevationChangeFt: -25, terrain: 'Gentle rolling', landmarks: [] },
    { number: 9, endMi: 9, elevationChangeFt: -25, terrain: 'Continued gentle descent', landmarks: [] },
    { number: 10, endMi: 10, elevationChangeFt: -10, terrain: 'Flattening out', landmarks: ['Natick'] },
    { number: 11, endMi: 11, elevationChangeFt: -15, terrain: 'Into Wellesley', landmarks: [] },
    { number: 12, endMi: 12, elevationChangeFt: -5, terrain: 'Wellesley — deafening crowd support', landmarks: ['Wellesley Scream Tunnel'] },
    { number: 13, endMi: 13, elevationChangeFt: 10, terrain: 'Slight rise', landmarks: ['Half marathon point'] },
    { number: 14, endMi: 14, elevationChangeFt: -10, terrain: 'Rolling', landmarks: [] },
    { number: 15, endMi: 15, elevationChangeFt: -10, terrain: 'Gentle descent', landmarks: [] },
    { number: 16, endMi: 16, elevationChangeFt: -35, terrain: 'Downhill to Newton Lower Falls — get ready for hills', landmarks: ['Newton Lower Falls'] },
    { number: 17, endMi: 17, elevationChangeFt: 85, terrain: 'NEWTON HILL #1 — first real climb', landmarks: ['Newton Hill 1'] },
    { number: 18, endMi: 18, elevationChangeFt: -30, terrain: 'Brief downhill reprieve', landmarks: [] },
    { number: 19, endMi: 19, elevationChangeFt: 50, terrain: 'NEWTON HILL #2 — grinding uphill', landmarks: ['Newton Hill 2'] },
    { number: 20, endMi: 20, elevationChangeFt: -15, terrain: 'Short downhill before Heartbreak', landmarks: ['Newton Hill 3 begins'] },
    { number: 21, endMi: 21, elevationChangeFt: 80, terrain: 'HEARTBREAK HILL — the iconic climb. Stay calm, shorten stride.', landmarks: ['Heartbreak Hill', 'Boston College'] },
    { number: 22, endMi: 22, elevationChangeFt: -90, terrain: 'Fast downhill — quads will feel it', landmarks: [] },
    { number: 23, endMi: 23, elevationChangeFt: -70, terrain: 'Continued descent into Brookline', landmarks: ['Brookline'] },
    { number: 24, endMi: 24, elevationChangeFt: -30, terrain: 'Heading into Boston', landmarks: ['Coolidge Corner'] },
    { number: 25, endMi: 25, elevationChangeFt: -20, terrain: 'Kenmore Square — Citgo sign in sight', landmarks: ['Kenmore Square', 'Citgo sign'] },
    { number: 26, endMi: 26, elevationChangeFt: -15, terrain: 'Right on Hereford, Left on Boylston — crowd roars', landmarks: ['Hereford St', 'Boylston St'] },
  ],
  aidStations: buildAidStations(
    [2.2, 4.6, 6.9, 9.2, 11.5, 13.8, 15, 16.1, 17.7, 19.3, 21.5, 23, 24.5],
    ['water', 'Gatorade Endurance']
  ),
};

// ═══════════════════════════════════════════════════════════════
//  LONDON MARATHON — April 26, 2026
// ═══════════════════════════════════════════════════════════════

const LONDON: MarathonRace = {
  id: 'london-marathon-2026',
  name: 'TCS London Marathon',
  city: 'London',
  country: 'United Kingdom',
  category: 'world-major',
  date: '2026-04-26',
  typicalMonth: 4,
  distanceMi: 26.2,
  courseType: 'loop',
  typicalTempF: { low: 45, high: 58 },
  typicalHumidity: 65,
  website: 'https://www.tcslondonmarathon.com',
  startTime: '10:00 AM BST',
  timeLimitHours: 8,
  fieldSize: 50000,
  isWorldMajor: true,
  year: 2026,
  courseDescription:
    'Starting in Greenwich Park near the Prime Meridian, the course heads east through Woolwich before turning west along the Thames. Runners pass through the Cutty Sark, cross Tower Bridge at mile 12, loop through the Docklands in miles 13-21, then finish along the Embankment past Big Ben and Buckingham Palace on The Mall. Largely flat with gentle undulations.',
  qualifyingInfo:
    'Entry via ballot (general), Good for Age qualifying times, championship entry, or charity places. Ballot acceptance ~15%.',
  tips: [
    'Very flat course — one of the best World Majors for a fast time after Berlin.',
    'Tower Bridge at mile 12 is an emotional highlight — don\'t get carried away.',
    'The Docklands loop (miles 14-21) can feel isolating. Stay focused.',
    'London\'s spring weather can be unpredictable — layers recommended.',
    'Cobblestones at Cutty Sark (mile 6) — watch your footing.',
    'The final stretch along The Mall with Buckingham Palace ahead is iconic.',
    'Crowd support is among the best in the world — 700,000+ spectators.',
  ],
  course: {
    totalGainFt: 220,
    totalLossFt: 240,
    netChangeFt: -20,
    highPointFt: 130,
    lowPointFt: 10,
    difficulty: 2,
    bqFriendly: true,
    prFriendly: true,
    elevationPoints: [
      { distanceMi: 0, elevationFt: 85, landmark: 'Greenwich Park (Start)' },
      { distanceMi: 2, elevationFt: 45 },
      { distanceMi: 4, elevationFt: 30, landmark: 'Woolwich' },
      { distanceMi: 6, elevationFt: 25, landmark: 'Cutty Sark' },
      { distanceMi: 8, elevationFt: 20 },
      { distanceMi: 10, elevationFt: 18 },
      { distanceMi: 12, elevationFt: 30, landmark: 'Tower Bridge' },
      { distanceMi: 13.1, elevationFt: 20, landmark: 'Half marathon' },
      { distanceMi: 15, elevationFt: 15, landmark: 'Canary Wharf' },
      { distanceMi: 17, elevationFt: 12 },
      { distanceMi: 19, elevationFt: 15 },
      { distanceMi: 21, elevationFt: 20, landmark: 'Docklands exit' },
      { distanceMi: 23, elevationFt: 18 },
      { distanceMi: 25, elevationFt: 15, landmark: 'Embankment' },
      { distanceMi: 26, elevationFt: 12, landmark: 'Big Ben / Parliament' },
      { distanceMi: 26.2, elevationFt: 10, landmark: 'The Mall / Buckingham Palace (Finish)' },
    ],
  },
  splits: buildEvenSplits(26, 'Flat urban roads', [
    { mile: 1, landmarks: ['Greenwich Park descent'], terrain: 'Gentle downhill from park' },
    { mile: 6, landmarks: ['Cutty Sark'], terrain: 'Cobblestones — watch footing' },
    { mile: 12, landmarks: ['Tower Bridge'], terrain: 'Slight rise onto bridge — iconic moment' },
    { mile: 15, landmarks: ['Canary Wharf'], terrain: 'Flat through Docklands' },
    { mile: 21, landmarks: ['Exit Docklands'], terrain: 'Back along Highway toward finish' },
    { mile: 25, landmarks: ['Embankment'], terrain: 'Flat along the Thames' },
    { mile: 26, landmarks: ['Big Ben', 'Buckingham Palace'], terrain: 'Turn onto The Mall — sprint finish' },
  ]),
  aidStations: buildAidStations([3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25], ['water', 'Lucozade Sport', 'gel']),
};

// ═══════════════════════════════════════════════════════════════
//  BERLIN MARATHON — September 27, 2026
// ═══════════════════════════════════════════════════════════════

const BERLIN: MarathonRace = {
  id: 'berlin-marathon-2026',
  name: 'BMW Berlin Marathon',
  city: 'Berlin',
  country: 'Germany',
  category: 'world-major',
  date: '2026-09-27',
  typicalMonth: 9,
  distanceMi: 26.2,
  courseType: 'loop',
  typicalTempF: { low: 48, high: 64 },
  typicalHumidity: 60,
  website: 'https://www.bmw-berlin-marathon.com',
  startTime: '9:15 AM CEST',
  timeLimitHours: 6.25,
  fieldSize: 45000,
  isWorldMajor: true,
  year: 2026,
  courseDescription:
    'The world\'s fastest marathon course. Starting near the Reichstag, the largely flat course loops through Berlin\'s diverse neighborhoods — Kreuzberg, Schöneberg, Charlottenburg — before the spectacular finish through the Brandenburg Gate. Nearly every world record in the last 20 years has been set here. A dream course for PR-seekers.',
  qualifyingInfo:
    'Entry via lottery or qualifying time. Lottery acceptance rate ~20%. Fast runners get priority entrance.',
  tips: [
    'THE course for a PR or BQ attempt — flattest of all World Majors.',
    'September weather in Berlin is typically ideal for marathoning.',
    'The finish through the Brandenburg Gate is one of sport\'s greatest moments.',
    'Pacing groups are excellent — latch onto one if you have a time goal.',
    'Aid stations every 5K with water, electrolyte, banana, and apple.',
    'Cobblestones in some sections — they\'re smoother than they look.',
    'Crowd support builds throughout and is electric near the finish.',
    'Nearly every WR since 2003 has been set here — the course is THAT fast.',
  ],
  course: {
    totalGainFt: 125,
    totalLossFt: 130,
    netChangeFt: -5,
    highPointFt: 180,
    lowPointFt: 110,
    difficulty: 1,
    bqFriendly: true,
    prFriendly: true,
    elevationPoints: [
      { distanceMi: 0, elevationFt: 150, landmark: 'Straße des 17. Juni (Start)' },
      { distanceMi: 2, elevationFt: 155 },
      { distanceMi: 4, elevationFt: 145 },
      { distanceMi: 5, elevationFt: 140, landmark: 'Kreuzberg' },
      { distanceMi: 7, elevationFt: 135 },
      { distanceMi: 9, elevationFt: 130 },
      { distanceMi: 10, elevationFt: 140, landmark: 'Schöneberg' },
      { distanceMi: 12, elevationFt: 145 },
      { distanceMi: 13.1, elevationFt: 140, landmark: 'Half marathon' },
      { distanceMi: 15, elevationFt: 135, landmark: 'Charlottenburg' },
      { distanceMi: 17, elevationFt: 145 },
      { distanceMi: 19, elevationFt: 150 },
      { distanceMi: 20, elevationFt: 155, landmark: 'Moabit' },
      { distanceMi: 22, elevationFt: 145 },
      { distanceMi: 24, elevationFt: 140 },
      { distanceMi: 25, elevationFt: 150, landmark: 'Unter den Linden' },
      { distanceMi: 26, elevationFt: 148 },
      { distanceMi: 26.2, elevationFt: 145, landmark: 'Brandenburg Gate (Finish)' },
    ],
  },
  splits: buildEvenSplits(26, 'Flat urban roads with some cobblestones', [
    { mile: 1, landmarks: ['Tiergarten'], terrain: 'Flat through park' },
    { mile: 5, landmarks: ['Kreuzberg'], terrain: 'Flat, vibrant neighborhood' },
    { mile: 10, landmarks: ['Schöneberg'], terrain: 'Flat, steady crowds' },
    { mile: 15, landmarks: ['Charlottenburg'], terrain: 'Flat, tree-lined streets' },
    { mile: 20, landmarks: ['Moabit'], terrain: 'Flat — maintain focus' },
    { mile: 25, landmarks: ['Unter den Linden'], terrain: 'Flat — crowds roar as you approach the Gate' },
    { mile: 26, landmarks: ['Brandenburg Gate'], terrain: 'Through the Gate — one of sport\'s great finishes' },
  ]),
  aidStations: buildAidStations([3.1, 6.2, 9.3, 12.4, 15.5, 17, 18.6, 20, 21.7, 23, 24.3], ['water', 'electrolyte', 'banana', 'apple']),
};

// ═══════════════════════════════════════════════════════════════
//  CHICAGO MARATHON — October 11, 2026
// ═══════════════════════════════════════════════════════════════

const CHICAGO: MarathonRace = {
  id: 'chicago-marathon-2026',
  name: 'Bank of America Chicago Marathon',
  city: 'Chicago',
  country: 'United States',
  category: 'world-major',
  date: '2026-10-11',
  typicalMonth: 10,
  distanceMi: 26.2,
  courseType: 'loop',
  typicalTempF: { low: 42, high: 60 },
  typicalHumidity: 55,
  website: 'https://www.chicagomarathon.com',
  startTime: '7:30 AM CT',
  timeLimitHours: 6.5,
  fieldSize: 47000,
  isWorldMajor: true,
  year: 2026,
  courseDescription:
    'Starting and finishing in Grant Park, the course tours 29 of Chicago\'s diverse neighborhoods. The completely flat course travels through Little Italy, Chinatown, Pilsen, Lincoln Park, Wrigleyville, and more. The city\'s grid system and lakefront setting provide one of the most spectator-friendly marathon experiences. A top-tier BQ and PR course.',
  qualifyingInfo:
    'Entry via lottery (general), guaranteed entry with qualifying times, or charity entry. Lottery acceptance ~30-40%.',
  tips: [
    'Extremely flat — second only to Berlin for PR potential among World Majors.',
    'Early October can range from very cold to surprisingly warm. Check forecast.',
    '2007 saw 88°F temps and a race cancellation — heat is the wildcard.',
    'The course tours 29 neighborhoods — each with its own energy and culture.',
    'Wind off Lake Michigan can affect the exposed sections.',
    'Miles 18-22 through Chinatown and Pilsen have thinner crowds — stay strong.',
    'The finish in Grant Park with the Chicago skyline is spectacular.',
    'Fueling stations are every 2 miles — well-stocked.',
  ],
  course: {
    totalGainFt: 105,
    totalLossFt: 105,
    netChangeFt: 0,
    highPointFt: 605,
    lowPointFt: 585,
    difficulty: 1,
    bqFriendly: true,
    prFriendly: true,
    elevationPoints: [
      { distanceMi: 0, elevationFt: 595, landmark: 'Grant Park (Start)' },
      { distanceMi: 2, elevationFt: 595 },
      { distanceMi: 4, elevationFt: 590 },
      { distanceMi: 5, elevationFt: 595, landmark: 'Lincoln Park' },
      { distanceMi: 7, elevationFt: 600, landmark: 'Wrigleyville' },
      { distanceMi: 9, elevationFt: 595 },
      { distanceMi: 10, elevationFt: 595 },
      { distanceMi: 13.1, elevationFt: 590, landmark: 'Half marathon — Near West Side' },
      { distanceMi: 15, elevationFt: 595, landmark: 'Little Italy' },
      { distanceMi: 17, elevationFt: 590 },
      { distanceMi: 19, elevationFt: 595, landmark: 'Pilsen' },
      { distanceMi: 21, elevationFt: 590, landmark: 'Chinatown' },
      { distanceMi: 23, elevationFt: 595 },
      { distanceMi: 25, elevationFt: 590, landmark: 'Michigan Avenue' },
      { distanceMi: 26, elevationFt: 592 },
      { distanceMi: 26.2, elevationFt: 595, landmark: 'Grant Park (Finish)' },
    ],
  },
  splits: buildEvenSplits(26, 'Completely flat city grid', [
    { mile: 1, landmarks: ['Grant Park'], terrain: 'Flat — north toward Lincoln Park' },
    { mile: 5, landmarks: ['Lincoln Park'], terrain: 'Flat through tree-lined streets' },
    { mile: 7, landmarks: ['Wrigleyville', 'Boys Town'], terrain: 'Flat — huge crowd energy' },
    { mile: 13, landmarks: ['Near West Side'], terrain: 'Flat — halfway point' },
    { mile: 15, landmarks: ['Little Italy', 'University Village'], terrain: 'Flat — embrace the neighborhoods' },
    { mile: 19, landmarks: ['Pilsen'], terrain: 'Flat — crowd support builds' },
    { mile: 21, landmarks: ['Chinatown'], terrain: 'Flat — stay mentally strong' },
    { mile: 25, landmarks: ['Michigan Avenue'], terrain: 'Flat — final push to Grant Park' },
  ]),
  aidStations: buildAidStations([1.6, 3.7, 5.7, 7.7, 9.7, 11.7, 13.7, 15.7, 17.7, 19.7, 21.5, 23.5, 25], ['water', 'Gatorade Endurance', 'gel']),
};

// ═══════════════════════════════════════════════════════════════
//  NEW YORK CITY MARATHON — November 1, 2026
// ═══════════════════════════════════════════════════════════════

const NYC: MarathonRace = {
  id: 'nyc-marathon-2026',
  name: 'TCS New York City Marathon',
  city: 'New York City',
  country: 'United States',
  category: 'world-major',
  date: '2026-11-01',
  typicalMonth: 11,
  distanceMi: 26.2,
  courseType: 'point-to-point',
  typicalTempF: { low: 40, high: 55 },
  typicalHumidity: 55,
  website: 'https://www.nyrr.org/tcsnycmarathon',
  startTime: '9:10 AM ET (Wave 1)',
  timeLimitHours: 8,
  fieldSize: 53000,
  isWorldMajor: true,
  year: 2026,
  courseDescription:
    'The world\'s largest marathon. Starting on Staten Island at the foot of the Verrazzano-Narrows Bridge, the course traverses all five boroughs of New York City: Staten Island, Brooklyn, Queens, the Bronx, and Manhattan. Famously hilly with five major bridge crossings. Not a PR course, but an unparalleled experience. Two million spectators line the route.',
  qualifyingInfo:
    'Entry via lottery, guaranteed entry with 15+ NYRR qualifying races (9+1), time qualifier, charity entry, or international travel partner. Lottery acceptance ~15%.',
  tips: [
    'NOT a PR course — hilly bridges, undulating terrain, and crowd-induced pace surges.',
    'The Verrazzano Bridge start is exposed and windy — don\'t overdress but bring a throwaway.',
    'Brooklyn (miles 3-13) is the easiest section — flat with incredible crowd energy.',
    'First Avenue in Manhattan (mile 16) is a mile-long party — DON\'T surge with the crowd.',
    'The Queensboro Bridge (mile 15) is silent, uphill, and a mental test. Stay patient.',
    'The Bronx section (miles 20-21) is short but the hills and empty-ish feel can break you.',
    'The final miles through Central Park have real hills — save something for them.',
    'November weather in NYC is usually ideal for running.',
  ],
  course: {
    totalGainFt: 890,
    totalLossFt: 770,
    netChangeFt: 120,
    highPointFt: 265,
    lowPointFt: 10,
    difficulty: 8,
    bqFriendly: false,
    prFriendly: false,
    elevationPoints: [
      { distanceMi: 0, elevationFt: 15, landmark: 'Staten Island (Start)' },
      { distanceMi: 1, elevationFt: 260, landmark: 'Verrazzano Bridge peak' },
      { distanceMi: 2, elevationFt: 50, landmark: 'Brooklyn — descent off bridge' },
      { distanceMi: 4, elevationFt: 40, landmark: 'Bay Ridge, Brooklyn' },
      { distanceMi: 6, elevationFt: 35 },
      { distanceMi: 8, elevationFt: 30, landmark: 'Bedford-Stuyvesant' },
      { distanceMi: 10, elevationFt: 25 },
      { distanceMi: 12, elevationFt: 30, landmark: 'Williamsburg' },
      { distanceMi: 13, elevationFt: 50, landmark: 'Pulaski Bridge into Queens' },
      { distanceMi: 13.1, elevationFt: 45, landmark: 'Half marathon — Long Island City' },
      { distanceMi: 14, elevationFt: 40 },
      { distanceMi: 15, elevationFt: 60, landmark: 'Queensboro Bridge (start)' },
      { distanceMi: 15.5, elevationFt: 130, landmark: 'Queensboro Bridge peak — silent, tough' },
      { distanceMi: 16, elevationFt: 25, landmark: 'First Avenue — the roar' },
      { distanceMi: 17, elevationFt: 20 },
      { distanceMi: 18, elevationFt: 25 },
      { distanceMi: 19, elevationFt: 30 },
      { distanceMi: 20, elevationFt: 80, landmark: 'Willis Ave Bridge into Bronx' },
      { distanceMi: 21, elevationFt: 75, landmark: 'The Bronx' },
      { distanceMi: 22, elevationFt: 50, landmark: 'Madison Ave Bridge back to Manhattan' },
      { distanceMi: 23, elevationFt: 90, landmark: 'Fifth Avenue uphill' },
      { distanceMi: 24, elevationFt: 130, landmark: 'Central Park — Harlem Hill' },
      { distanceMi: 25, elevationFt: 100, landmark: 'Central Park South' },
      { distanceMi: 25.5, elevationFt: 110, landmark: 'Cat Hill' },
      { distanceMi: 26, elevationFt: 85, landmark: 'Central Park loop' },
      { distanceMi: 26.2, elevationFt: 80, landmark: 'Central Park (Finish)' },
    ],
  },
  splits: [
    { number: 1, endMi: 1, elevationChangeFt: 245, terrain: 'Verrazzano Bridge — steep uphill, windy, exposed', landmarks: ['Verrazzano-Narrows Bridge'] },
    { number: 2, endMi: 2, elevationChangeFt: -210, terrain: 'Bridge descent into Brooklyn — control downhill', landmarks: ['Brooklyn entrance'] },
    { number: 3, endMi: 3, elevationChangeFt: -10, terrain: 'Flat through Bay Ridge', landmarks: ['4th Avenue'] },
    { number: 4, endMi: 4, elevationChangeFt: 0, terrain: 'Flat — enjoy Brooklyn\'s amazing crowds', landmarks: ['Bay Ridge'] },
    { number: 5, endMi: 5, elevationChangeFt: -5, terrain: 'Flat through Park Slope area', landmarks: [] },
    { number: 6, endMi: 6, elevationChangeFt: -5, terrain: 'Flat', landmarks: [] },
    { number: 7, endMi: 7, elevationChangeFt: 0, terrain: 'Flat through Clinton Hill', landmarks: [] },
    { number: 8, endMi: 8, elevationChangeFt: -5, terrain: 'Flat through Bed-Stuy', landmarks: ['Bedford-Stuyvesant'] },
    { number: 9, endMi: 9, elevationChangeFt: 0, terrain: 'Flat', landmarks: [] },
    { number: 10, endMi: 10, elevationChangeFt: -5, terrain: 'Northern Brooklyn', landmarks: [] },
    { number: 11, endMi: 11, elevationChangeFt: 0, terrain: 'Flat through Greenpoint', landmarks: [] },
    { number: 12, endMi: 12, elevationChangeFt: 5, terrain: 'Williamsburg', landmarks: ['Williamsburg'] },
    { number: 13, endMi: 13, elevationChangeFt: 20, terrain: 'Pulaski Bridge — short uphill into Queens', landmarks: ['Pulaski Bridge'] },
    { number: 14, endMi: 14, elevationChangeFt: -10, terrain: 'Long Island City', landmarks: ['Half marathon nearby'] },
    { number: 15, endMi: 15, elevationChangeFt: 20, terrain: 'Approaching Queensboro Bridge', landmarks: [] },
    { number: 16, endMi: 16, elevationChangeFt: -35, terrain: 'Queensboro Bridge descent — crowd silence then First Ave explosion', landmarks: ['Queensboro Bridge', 'First Avenue'] },
    { number: 17, endMi: 17, elevationChangeFt: -5, terrain: 'First Avenue — massive crowd energy', landmarks: ['First Avenue'] },
    { number: 18, endMi: 18, elevationChangeFt: 5, terrain: 'Upper East Side', landmarks: [] },
    { number: 19, endMi: 19, elevationChangeFt: 5, terrain: 'East Harlem', landmarks: [] },
    { number: 20, endMi: 20, elevationChangeFt: 50, terrain: 'Willis Avenue Bridge — climb into Bronx', landmarks: ['Willis Ave Bridge'] },
    { number: 21, endMi: 21, elevationChangeFt: -5, terrain: 'Short out-and-back in the Bronx', landmarks: ['The Bronx'] },
    { number: 22, endMi: 22, elevationChangeFt: -25, terrain: 'Madison Ave Bridge back to Manhattan', landmarks: ['Madison Ave Bridge'] },
    { number: 23, endMi: 23, elevationChangeFt: 40, terrain: 'Fifth Avenue uphill — tough at this point', landmarks: ['Fifth Avenue'] },
    { number: 24, endMi: 24, elevationChangeFt: 40, terrain: 'Enter Central Park — Harlem Hill hurts', landmarks: ['Central Park', 'Harlem Hill'] },
    { number: 25, endMi: 25, elevationChangeFt: -30, terrain: 'Central Park South — almost there', landmarks: ['Central Park South'] },
    { number: 26, endMi: 26, elevationChangeFt: -15, terrain: 'Final push through Central Park', landmarks: ['Cat Hill (small)'] },
  ],
  aidStations: buildAidStations(
    [3, 5, 7, 9, 11, 13, 15, 16.5, 18, 19.5, 21, 22.5, 24, 25],
    ['water', 'Gatorade Endurance']
  ),
};

// ═══════════════════════════════════════════════════════════════
//  HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════

function buildEvenSplits(
  totalMiles: number,
  defaultTerrain: string,
  overrides: { mile: number; landmarks: string[]; terrain: string }[]
): CourseSplit[] {
  const overrideMap = new Map(overrides.map((o) => [o.mile, o]));
  const splits: CourseSplit[] = [];
  for (let i = 1; i <= totalMiles; i++) {
    const override = overrideMap.get(i);
    splits.push({
      number: i,
      endMi: i,
      elevationChangeFt: 0,
      terrain: override?.terrain ?? defaultTerrain,
      landmarks: override?.landmarks ?? [],
    });
  }
  return splits;
}

function buildAidStations(positions: number[], offerings: string[]): AidStation[] {
  return positions.map((pos, idx) => ({
    distanceMi: pos,
    name: `Station ${idx + 1}`,
    offerings,
  }));
}

// ═══════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════

export const WORLD_MAJOR_MARATHONS: MarathonRace[] = [
  TOKYO,
  BOSTON,
  LONDON,
  BERLIN,
  CHICAGO,
  NYC,
];

/** Get a marathon by ID from the built-in database */
export function getMarathonById(id: string): MarathonRace | undefined {
  return WORLD_MAJOR_MARATHONS.find((m) => m.id === id);
}

/** Get all World Major Marathons sorted by date */
export function getWorldMajorsByDate(): MarathonRace[] {
  return [...WORLD_MAJOR_MARATHONS].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );
}

/** Get the next upcoming World Major from today */
export function getNextWorldMajor(): MarathonRace | null {
  const now = Date.now();
  const upcoming = WORLD_MAJOR_MARATHONS
    .filter((m) => new Date(m.date).getTime() > now)
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  return upcoming[0] ?? null;
}
