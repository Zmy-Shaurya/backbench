// Imposter Word pairs: "Category: word/decoy, ..." (160 pairs, 8 categories)
const RAW = `
Food: Samosa/Kachori, Maggi/Yippee, Biryani/Pulao, Dosa/Uttapam, Pani Puri/Bhel Puri, Chai/Coffee, Paneer/Tofu, Momos/Dumplings, Pizza/Burger, Lassi/Buttermilk, Jalebi/Imarti, Paratha/Naan, Rajma/Chole, Idli/Dhokla, Gulab Jamun/Rasgulla, Vada Pav/Pav Bhaji, Khichdi/Daliya, Mango/Papaya, Ice Cream/Kulfi, Noodles/Pasta
Campus: Canteen/Mess, Proxy/Bunk, Hostel/PG, Library/Reading Room, Attendance/Roll Call, Assignment/Project, Professor/TA, Fest/Farewell, Placement/Internship, Backbencher/Topper, Lab/Workshop, Warden/Guard, ID Card/Library Card, Fresher Party/Farewell Party, Notes/Xerox, Semester/Trimester, Canteen Uncle/Mess Didi, Bench/Desk, Lecture/Tutorial, Club/Society
Cricket: Yorker/Bouncer, Six/Four, Wicketkeeper/Slip, Dhoni/Kohli, IPL/World Cup, Umpire/Referee, Stumps/Bails, Googly/Doosra, Run Out/Stumped, Hat-trick/Maiden, Captain/Vice Captain, Helmet/Pads, Test Match/T20, Duck/Golden Duck, Free Hit/No Ball, DRS/Third Umpire, Spinner/Pacer, Toss/Coin, Pitch/Outfield, Sachin/Sehwag
Movies: 3 Idiots/Chhichhore, Sholay/Deewar, DDLJ/Kuch Kuch Hota Hai, Dangal/Sultan, Bahubali/RRR, KGF/Pushpa, Lagaan/Chak De India, Avengers/Justice League, Titanic/Avatar, Harry Potter/Lord of the Rings, Spider-Man/Batman, ZNMD/Dil Chahta Hai, Hera Pheri/Golmaal, Jawan/Pathaan, Dhoom/Race, PK/OMG, Inception/Interstellar, Frozen/Moana, Joker/Venom, Animal/Kabir Singh
Travel: Manali/Shimla, Goa/Pondicherry, Train/Bus, Airport/Railway Station, Ladakh/Spiti, Kerala/Coorg, Rishikesh/Haridwar, Jaipur/Udaipur, Passport/Visa, Backpack/Suitcase, Hotel/Hostel, Beach/Lake, Mountain/Hill, Tent/Cabin, Road Trip/Trek, Taxi/Auto, Metro/Local Train, Dubai/Singapore, Paris/London, Ticket/Boarding Pass
Tech: Instagram/Snapchat, WhatsApp/Telegram, YouTube/Netflix, iPhone/Android, Laptop/Tablet, Google/Bing, ChatGPT/Gemini, WiFi/Hotspot, Charger/Power Bank, Earphones/Headphones, Reels/Shorts, Spotify/JioSaavn, PUBG/Free Fire, Minecraft/Roblox, Password/OTP, Selfie/Screenshot, Keyboard/Mouse, Bluetooth/NFC, Zoom/Google Meet, Amazon/Flipkart
Exams: Viva/Practical, Mid-sem/End-sem, Cheat Sheet/Chit, Invigilator/Examiner, Backlog/Reappear, CGPA/Percentage, Answer Sheet/Question Paper, Syllabus/Timetable, MCQ/Essay, All-nighter/Revision, Admit Card/Result, Supplementary/Improvement, Grace Marks/Bonus Marks, Calculator/Scale, Pen/Pencil, Topper/Rank Holder, JEE/NEET, Board Exam/Entrance Exam, Surprise Test/Class Test, Report Card/Marksheet
Places: Sukhna Lake/Rock Garden, Mall/Market, Gym/Park, Temple/Gurudwara, Hospital/Clinic, Cinema/Theatre, Bank/ATM, Zoo/Museum, Cafe/Dhaba, Metro Station/Bus Stop, Barber/Salon, Swimming Pool/Water Park, Stadium/Playground, Police Station/Court, Kirana Store/Supermarket, Petrol Pump/Car Wash, Wedding/Engagement, Birthday/Anniversary, Diwali/Holi, Rain/Snow`;

export const PAIRS = RAW.trim().split('\n').flatMap(line => {
  const [category, rest] = line.split(': ');
  return rest.split(', ').map(p => { const [word, decoy] = p.split('/'); return { category, word, decoy }; });
});

export const PROMPTS = [
  'Professor sleeping in his own lecture', 'Cow stuck in traffic', 'WiFi password on a sticky note',
  'Exam paper crying', 'Dhoni hitting a six off a samosa', 'Hostel maggi at 3 AM', 'Proxy attendance gone wrong',
  'Auto driver refusing to go', 'Phone at 1% battery', 'Monkey stealing a selfie stick', 'Chai with too much sugar',
  'Topper hiding notes', 'Dog chasing a scooter', 'Elephant on a cycle', 'Rain on result day',
  'Batman eating pani puri', 'Library at exam time', 'Fan falling from the ceiling', 'Mosquito with a sword',
  'Group project, one worker', 'Alarm clock exploding', 'Cricket ball through a window', 'Aunty spotting you on a date',
  'Last bench secret meeting', 'Pizza delivery by rocket', 'Ghost in the hostel bathroom', 'Teacher catching a chit',
  'Penguin in Rajasthan', 'Train running late (again)', 'Cat working from home', 'Dinosaur at a wedding',
  'Robot making rotis', 'Lost in a mall', 'Superhero with a cold', 'Free food in the canteen',
  'Goat climbing a tree', 'Sun wearing sunglasses', 'Fish riding a bus', 'Viva panic', 'Midnight birthday bumps',
];

// Clean mode: English + Hinglish. Short ones match as whole words only.
const BAD = /\b(bc|mc|bsdk)\b|fuck|shit|bitch|bastard|asshole|dick|pussy|cunt|slut|whore|madarchod|behenchod|bhenchod|chutiy|gandu|bhosd|lund|lauda|lavda|randi|harami/gi;
export const clean = s => s.replace(BAD, m => '*'.repeat(m.length));

// Who Said It? prompts
export const WHO_PROMPTS = [
  "What's your most useless talent?", 'Worst excuse you have given for missing class?', 'What would you do with ₹1 crore by tonight?',
  'Your most embarrassing autocorrect moment?', 'If you were a canteen item, which one and why?', 'What song is secretly on repeat for you?',
  'Weirdest food combo you actually like?', 'What would your villain name be?', 'Biggest lie you told a teacher?',
  'First thing you would do if you became invisible?', 'Most overrated thing in college?', 'What is your 3 AM thought?',
  'Which celebrity would you swap lives with for a day?', 'Your toxic trait in one line?', 'What would you name your autobiography?',
  'Worst gift you have ever received?', 'If your pet could talk, what would it complain about?', 'Your go-to karaoke song?',
  'Most random thing in your bag right now?', 'What job would you be terrible at?', 'The pettiest thing that annoys you?',
  'What do you do when nobody is watching?', 'A superpower you would want, but useless?', 'Describe your dream weekend in 5 words',
  'What would you ban if you were PM for a day?', 'Last thing you googled that you would not admit?', 'Your hidden fear?',
  'What reality show would you win?', 'If you were a WhatsApp group, what would it be called?', 'Best advice you ignored?',
];

// Pass the Bomb categories
export const BOMB_CATS = [
  'Fruits', 'Vegetables', 'Indian dishes', 'Sweets', 'Bollywood actors', 'Cricketers', 'Countries', 'Indian cities',
  'Animals', 'Birds', 'Car brands', 'Phone brands', 'Apps', 'Things in a classroom', 'Things in a kitchen', 'Colours',
  'Body parts', 'Sports', 'Board games', 'Musical instruments', 'Professions', 'Superheroes', 'Cartoon characters',
  'Drinks', 'Things that are cold', 'Things with wheels', 'School subjects', 'Clothes', 'Festivals', 'Rivers',
];

// Emoji Decode: "emoji = answer | alternative | ..."
export const EMOJI_PUZZLES = `
🦁👑 = The Lion King | lion king
🚢🧊💔 = Titanic
🕷️🧑 = Spider-Man | spiderman
🦇🧑 = Batman
🧙‍♂️💍🌋 = Lord of the Rings
⚡👓🧙 = Harry Potter
🦖🏝️ = Jurassic Park
👻👻🔫 = Ghostbusters
🐠🔍 = Finding Nemo
❄️👸⛄ = Frozen
🧸🤠🚀 = Toy Story
🐼🥋 = Kung Fu Panda
🍫🏭 = Charlie and the Chocolate Factory | chocolate factory
🌌⭐⚔️ = Star Wars
🏴‍☠️🚢💀 = Pirates of the Caribbean
🎓🎓🎓 = 3 Idiots | three idiots
🏏🌧️🇮🇳 = Lagaan
🤼‍♀️👨‍👧‍👧 = Dangal
🏑🇮🇳👩 = Chak De India | chak de
🚂❤️🌻 = DDLJ | Dilwale Dulhania Le Jayenge
👽📞🏠 = ET | E.T.
🧠😢😡😱 = Inside Out
🏠🎈👴 = Up
🐀👨‍🍳 = Ratatouille
🤖🌱💚 = WALL-E | walle
🔨⚡👱 = Thor
🛡️⭐🇺🇸 = Captain America
👨‍🚀🌽🕳️⏳ = Interstellar
💭💭🌀 = Inception
🃏😂 = Joker
🧟‍♂️🚂 = Train to Busan
🏎️💨👨‍👩‍👦 = Fast and Furious | fast & furious
👸🐸 = The Princess and the Frog | princess and the frog
🔍🕵️‍♂️🎻 = Sherlock | Sherlock Holmes
👑🐉❄️ = Game of Thrones
🧪👨‍🔬💰 = Breaking Bad
👫☕🛋️ = Friends
🦑🎮💰 = Squid Game
🚲👦👻🙃 = Stranger Things
💸🏦🎭 = Money Heist
🏏🚁 = Helicopter Shot | MS Dhoni | Dhoni
🐍🪜 = Snakes and Ladders
🍕🍍 = Pineapple Pizza
🌧️☕🥟 = Chai Pakoda | chai pakora | chai pakode
💍👰🤵 = Wedding
🐔🥚❓ = Chicken or the Egg | chicken and egg
🐢🐇🏁 = The Tortoise and the Hare | tortoise and hare | hare and tortoise
🎅🎄🎁 = Christmas
🪔🎆🍬 = Diwali
🌈🎨💦 = Holi
🐘🙏🎉 = Ganesh Chaturthi | ganpati | ganesh
⏰😴🛌 = Snooze
📱🪫 = Low Battery
🧊🐘👶 = Ice Age
🦍🏙️ = King Kong
🦈🌊🏊 = Jaws
🎈🤡 = It
`.trim().split('\n').map(l => { const [e, a] = l.split(' = '); return { e, a: a.split(' | ') }; });


// Type Race passages: original text, plain ASCII so every keyboard can type it
export const PASSAGES = [
  'The last bench in the classroom has a view of everything: the clock, the door, the teacher, and the window where the afternoon slowly turns gold while everyone pretends to take notes.',
  'Good friends will wait for you at the gate, save you a seat in the canteen, and still laugh at the same joke on the hundredth time you tell it, even when it was never funny.',
  'Rain on a tin roof sounds like a crowd clapping for nobody. Inside, the tea is too sweet, the power has gone out, and somebody has found a pack of cards and a candle.',
  'A good shortcut is never short. It goes past the bakery, around the park, under the old bridge, and somehow always ends at the place where you were supposed to be ten minutes ago.',
  'The night before an exam, every topic looks new. The textbook feels heavier, the clock moves faster, and the phone suddenly has the most interesting messages ever written.',
  'Cricket in the street has its own rules. One bounce and you are out, the wall is the wicket, and if the ball goes over the neighbour fence, the batter has to fetch it.',
  'Every road trip needs three things: a playlist nobody agrees on, a bag of snacks that is finished in the first hour, and one friend who insists they know the way.',
  'The city wakes up in layers. First the milk vans, then the joggers, then the buses full of sleepy faces, and finally the traffic that will not move again until late tonight.',
  'Learning to cook starts with a simple promise: nothing will burn today. Then the onions turn black, the smoke alarm sings, and dinner becomes a story told for years.',
  'A cat does not care about your plans. It will sit on your keyboard, knock your pen off the table, and fall asleep in the exact spot where you were about to sit down.',
  'Typing fast is not about speed. It is about rhythm, about trusting your fingers, and about not looking down at the keys every time your brain starts to panic.',
  'The best part of a power cut is the silence. No fans, no screens, no music. Just voices on the balcony and the sound of the whole street deciding to talk to each other.',
  'Somewhere a group of friends is planning a trip that will never happen. The dates keep changing, the budget keeps shrinking, and the group chat keeps getting louder.',
  'Mountains make everyone quiet. You climb for hours, legs burning, and then the clouds open and the whole valley is there below you, small and green and impossibly far.',
  'A library smells of old paper and patience. Nobody hurries, nobody shouts, and every shelf holds a door to a place you have not been yet.',
  'The final over is always the longest. Six balls, ten runs to win, and the whole ground holding its breath every time the bowler starts his run.',
  'Street food tastes better at night. The lights are warm, the queue is long, the plates are paper, and the chutney is spicy enough to make your eyes water.',
  'Every group project has a hero, a ghost, and someone who adds the title page at midnight and calls it teamwork.',
  'Old phones never die. They move to a drawer, then to a grandparent, then back to the drawer, waiting for the day someone needs an alarm clock again.',
  'The sea is never the same twice. Some days it is flat and silver, some days it throws itself at the rocks, and some days it just hums to itself in the dark.',
];
