/**
 * Hebrew strings — the default locale.
 *
 * `meta.dir` is `rtl`, which the shell applies to `<html dir>`; the layout uses
 * logical CSS properties throughout, so mirroring needs no separate stylesheet.
 *
 * Terminology follows the owner's SuperTaki project so the two games read as a
 * pair: קוד החדר, העתקת הקוד, שיתוף, and so on.
 *
 * A note on the game's name: SET stays in Latin letters. It is the name of the
 * thing being claimed and appears on the button players press, and "סט" reads as
 * a generic set of objects rather than as this game's move.
 */

import type { StringKey } from './en.js';

export const he = {
  'meta.dir': 'rtl',

  'app.title': 'SET',
  'app.tagline': 'מצאו את הסט לפני כולם',

  'common.back': 'חזרה',
  'common.cancel': 'ביטול',
  'common.close': 'סגירה',
  'common.retry': 'נסו שוב',
  'common.home': 'חזרה לדף הבית',
  'common.loading': 'טוען…',
  'common.copied': 'הועתק',
  'common.you': 'אתם',
  'common.host': 'מנהל',

  'home.explain': 'מצאו שלושה קלפים שבהם כל תכונה זהה לגמרי או שונה לגמרי.',
  'home.create': 'משחק חדש',
  'home.join': 'הצטרפות למשחק',
  'home.howToPlay': 'איך משחקים',
  'home.codeLabel': 'קוד החדר',
  'home.codePlaceholder': 'ABC234',
  'home.nameLabel': 'השם שלכם',
  'home.namePlaceholder': 'למשל: מיה',
  'home.continue': 'המשך',
  'home.creating': 'יוצר חדר…',
  'home.joining': 'מצטרף לחדר…',
  'home.nameRequired': 'נא להזין שם.',
  'home.nameTooLong': 'השם יכול להיות עד {max} תווים.',
  'home.codeRequired': 'נא להזין קוד חדר.',
  'home.codeInvalid': 'קוד חדר מורכב מ-{length} אותיות וספרות.',

  'lobby.title': 'חדר {code}',
  'lobby.inviteTitle': 'הזמנת שחקנים',
  'lobby.inviteBody': 'שלחו להם את הקוד או את הקישור. הם מצטרפים מהמכשיר שלהם.',
  'lobby.inviteLink': 'קישור הזמנה',
  'lobby.qrCaption': 'או סריקה מהטלפון',
  'lobby.qrLabel': 'קוד QR עם קישור ההזמנה לחדר {room}',
  'lobby.shareText': 'בואו לשחק SET — חדר {code}',
  'lobby.shareUnavailable': 'שיתוף אינו נתמך בדפדפן הזה. אפשר להעתיק את הקישור.',
  'common.copyLink': 'העתקת קישור',
  'common.copyCode': 'העתקת הקוד',
  'common.share': 'שיתוף',
  'lobby.players': 'שחקנים ({count}/{max})',
  'lobby.waitingForHost': 'ממתינים ש{name} יתחיל את המשחק…',
  'lobby.needMorePlayers': 'ממתינים ל-{min} שחקנים לפחות…',
  'lobby.start': 'התחלת המשחק',
  'lobby.leave': 'יציאה מהחדר',
  'lobby.disconnected': 'מתחבר מחדש…',
  'lobby.hint': 'כולם משחקים בבת אחת — אין תורות.',
  'lobby.noTurns': 'אין תורות',
  'lobby.noTurnsBody':
    'כל השחקנים רואים את אותם הקלפים באותו הזמן ומתחרים מי ימצא סט ראשון. אף אחד לא מחכה לאף אחד.',

  'game.claim': 'מצאתי SET',
  'game.claimSelected': 'מצאתי SET ({count}/3)',
  'game.noSet': 'אין SET על השולחן',
  'game.deckLeft': 'נשארו {count}',
  'game.deckLeftLabel': '{count} קלפים נשארו בקופה',
  'game.setsFound': 'נמצאו {count}',
  'game.setsFoundLabel': '{count} סטים נמצאו עד כה',
  'game.scoresLabel': 'ניקוד',
  'game.playerScore': '{name}: {score}',
  'game.cooldown': 'המתינו {seconds} שנ׳',
  'game.selectThree': 'בחרו שלושה קלפים',
  'game.fourthBlocked': 'אפשר לבחור שלושה קלפים בלבד. הקישו על קלף נבחר כדי לבטל אותו.',
  'game.cardLabel': '{count} {shape} {color} {fill}',
  'game.selectedPosition': 'נבחר, מקום {index} מתוך 3',
  'game.boardLabel': 'שולחן המשחק, {count} קלפים',
  'game.leave': 'יציאה',
  'game.leaveConfirm': 'הקישו שוב ליציאה',

  'feed.setFound': '{name} מצא SET \u200e+1',
  'feed.setFoundYou': 'מצאתם SET \u200e+1',
  'feed.invalidClaim': 'ל{name} לא היה SET',
  'feed.invalidClaimYou': 'זה לא SET',
  'feed.cardsAdded': 'נוספו 3 קלפים',
  'feed.noSetRejected': '{name} הכריז שאין SET, אבל יש',
  'feed.playerJoined': '{name} הצטרף',
  'feed.playerLeft': '{name} יצא',
  'feed.playerDisconnected': '{name} התנתק',
  'feed.playerReconnected': '{name} חזר',
  'feed.hostChanged': '{name} הוא המנהל עכשיו',
  'feed.gameStarted': 'מתחילים!',
  'feed.rematchWanted': '{name} רוצה סיבוב נוסף',

  'reject.notASet': 'זה לא SET: {repeated} פעמיים ו{odd} פעם אחת ({attribute}).',
  'reject.notASetGeneric': 'זה לא SET.',
  'reject.boardChanged': 'השולחן השתנה — נסו שוב.',
  'reject.cooldown': 'רגע אחד — המתינו לטיימר.',
  'reject.notPlaying': 'המשחק לא פעיל.',
  'reject.invalidCards': 'בחרו שלושה קלפים שונים מהשולחן.',
  'reject.setExists': 'עדיין יש SET על השולחן.',

  'attribute.count': 'כמות',
  'attribute.shape': 'צורה',
  'attribute.color': 'צבע',
  'attribute.fill': 'מילוי',

  // Digits, not words: "3 גליים סגולים" is idiomatic, whereas a spelled-out
  // numeral would need the construct state ("שלושה" vs "שלוש") to agree with each
  // shape's gender — a grammar trap for a string that a screen reader reads out.
  'value.count.one': '1',
  'value.count.two': '2',
  'value.count.three': '3',
  'value.shape.oval': 'סגלגל',
  'value.shape.diamond': 'מעוין',
  'value.shape.squiggle': 'גלי',
  'value.shapePlural.oval': 'סגלגלים',
  'value.shapePlural.diamond': 'מעוינים',
  'value.shapePlural.squiggle': 'גליים',
  'value.color.red': 'אדום',
  'value.color.green': 'ירוק',
  'value.color.purple': 'סגול',
  'value.colorPlural.red': 'אדומים',
  'value.colorPlural.green': 'ירוקים',
  'value.colorPlural.purple': 'סגולים',
  'value.fill.open': 'ריק',
  'value.fill.striped': 'מפוספס',
  'value.fill.solid': 'מלא',
  'value.fillPlural.open': 'ריקים',
  'value.fillPlural.striped': 'מפוספסים',
  'value.fillPlural.solid': 'מלאים',

  'results.title': 'ניקוד סופי',
  'results.winner': '{name} ניצח!',
  'results.winnerYou': 'ניצחתם!',
  'results.tie': 'תיקו: {names}',
  'results.setsFound': '{count} סטים',
  'results.playAgain': 'סיבוב נוסף',
  'results.startRematch': 'התחלת סיבוב נוסף',
  'results.waitingForHost': 'ממתינים ש{name} יתחיל סיבוב נוסף…',
  'results.wantsRematch': 'מוכן',
  'results.leave': 'יציאה מהחדר',

  'tutorial.title': 'איך משחקים',
  'tutorial.intro': 'SET הוא שלושה קלפים שבהם כל אחת מארבע התכונות זהה בכולם או שונה בכולם.',
  'tutorial.features': 'לכל קלף יש ארבע תכונות:',
  'tutorial.featureCount': 'כמות — צורה אחת, שתיים או שלוש',
  'tutorial.featureShape': 'צורה — סגלגל, מעוין או גלי',
  'tutorial.featureColor': 'צבע — אדום, ירוק או סגול',
  'tutorial.featureFill': 'מילוי — ריק, מפוספס או מלא',
  'tutorial.validSameHeading': 'תקין — אותה צורה, צבע ומילוי; אחד, שניים, שלושה',
  'tutorial.validAllDiffHeading': 'תקין — כל תכונה שונה לגמרי',
  'tutorial.invalidHeading': 'לא SET — שניים סגולים ואחד ירוק',
  'tutorial.invalidWhy': 'אם אפילו בתכונה אחת יש שניים זהים ואחד שונה — זה לא SET.',
  'tutorial.flowTitle': 'איך מתנהל משחק',
  'tutorial.flowTurns':
    'אין תורות. כולם משחקים בבת אחת על אותם שנים־עשר קלפים, והראשון שמכריז נכון לוקח אותם.',
  'tutorial.flowClaim':
    'הקישו על שלושה קלפים ואז על «מצאתי SET». נכון — נקודה לזכותכם. לא נכון — אתם בלבד מושהים ל-5 שניות, וכל השאר ממשיכים לשחק.',
  'tutorial.flowRefill':
    'השולחן מתמלא מעצמו בחזרה לשנים־עשר קלפים מהקופה, כך שכמעט תמיד יש שנים־עשר קלפים לפניכם.',
  'tutorial.flowNoSet':
    'אם אף אחד לא מוצא SET, כל שחקן יכול להקיש «אין SET על השולחן». אם באמת אין — נוספים שלושה קלפים (חמישה־עשר, אחר כך שמונה־עשר), ולא מתחלפים קלפים עד שהשולחן חוזר לשנים־עשר.',
  'tutorial.flowDeck':
    'המונה בראש המסך מראה כמה קלפים נשארו בקופה, מתוך 81. המשחק נגמר כשהקופה ריקה ואין יותר SET על השולחן. מי שמצא הכי הרבה סטים מנצח, וניקוד זהה הוא תיקו.',
  'tutorial.gotIt': 'הבנתי',

  'settings.language': 'שפה',
  'settings.title': 'תצוגה',
  'settings.colorAssist': 'סימון לעיוורי צבעים',
  'settings.colorAssistHint': 'הצגת האותיות א / י / ס על כל קלף.',

  'status.connecting': 'מתחבר…',
  'status.reconnecting': 'מתחבר מחדש… ({attempt})',
  'status.offline': 'אין חיבור לאינטרנט. ממתינים לרשת…',
  'status.reconnected': 'החיבור חזר',

  'error.title': 'משהו השתבש',
  'error.roomNotFound': 'קוד החדר הזה לא קיים. בדקו את הקוד ונסו שוב.',
  'error.roomFull': 'החדר הזה מלא.',
  'error.gameAlreadyStarted': 'המשחק הזה כבר התחיל.',
  'error.notAuthorized': 'המקום הזה שייך לשחקן אחר. הצטרפו מחדש כדי לקבל מקום חדש.',
  'error.roomClosed': 'החדר הזה נסגר.',
  'error.versionMismatch': 'הדף הזה לא מעודכן. רעננו כדי לקבל את הגרסה החדשה.',
  'error.network': 'אין גישה לשרת המשחק. בדקו את החיבור ונסו שוב.',
  'error.backendUnconfigured': 'לגרסה הזו לא הוגדר שרת משחק. הגדירו VITE_API_BASE בזמן הבנייה.',
  'error.originNotAllowed':
    'שרת המשחק לא מוגדר לכתובת הזו. הוסיפו אותה ל-ALLOWED_ORIGINS ב-Worker.',
  'error.generic': 'משהו השתבש. נסו שוב.',
  'error.lostConnection': 'החיבור אבד. מנסים להחזיר אתכם למשחק…',
  'error.rejoin': 'הצטרפות מחדש',
  'error.reload': 'רענון',
} as const satisfies Record<StringKey, string>;
