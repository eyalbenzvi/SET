/**
 * English UI strings — the default and reference locale.
 *
 * Every user-facing string in the app lives here. To add a locale (Hebrew is the
 * intended next one), copy this object, translate the values, register it in
 * `i18n/index.ts`, and set `dir: 'rtl'` in that locale's metadata. No component
 * contains literal display text, so no component needs to change.
 *
 * Placeholders use `{name}` syntax and are substituted as plain text.
 */

export const en = {
  'meta.dir': 'ltr',

  'app.title': 'SET',
  'app.tagline': 'Spot the set faster than your friends',

  'common.back': 'Back',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.retry': 'Try again',
  'common.home': 'Back to home',
  'common.loading': 'Loading…',
  // Shown on the button that was just tapped, which may have copied either the
  // code or the link — so it names neither.
  'common.copied': 'Copied',
  'common.you': 'you',
  'common.host': 'Host',

  'home.explain': 'Find three cards where every feature is all the same or all different.',
  'home.create': 'Create game',
  'home.join': 'Join game',
  'home.howToPlay': 'How to play',
  'home.codeLabel': 'Room code',
  'home.codePlaceholder': 'ABC234',
  'home.nameLabel': 'Your name',
  'home.namePlaceholder': 'e.g. Maya',
  'home.continue': 'Continue',
  'home.creating': 'Creating room…',
  'home.joining': 'Joining room…',
  'home.nameRequired': 'Please enter a name.',
  'home.nameTooLong': 'Names can be up to {max} characters.',
  'home.codeRequired': 'Please enter a room code.',
  'home.codeInvalid': 'Room codes are {length} letters and digits.',

  'lobby.title': 'Room {code}',
  'lobby.inviteTitle': 'Invite players',
  'lobby.inviteBody': 'Send them the code or the link. They join from their own device.',
  'lobby.inviteLink': 'Invite link',
  'lobby.qrCaption': 'or scan from a phone',
  'lobby.qrLabel': 'QR code with the invite link for room {room}',
  'lobby.shareText': 'Join my SET game — room {code}',
  'lobby.shareUnavailable': 'Sharing is not supported in this browser. You can copy the link.',
  'common.copyLink': 'Copy link',
  'common.copyCode': 'Copy code',
  'common.share': 'Share',
  'lobby.players': 'Players ({count}/{max})',
  'lobby.waitingForHost': 'Waiting for {name} to start the game…',
  'lobby.needMorePlayers': 'Waiting for at least {min} players…',
  'lobby.start': 'Start game',
  'lobby.leave': 'Leave room',
  'lobby.disconnected': 'reconnecting…',
  'lobby.hint': 'Everyone plays at the same time — there are no turns.',
  'lobby.noTurns': 'No turns',
  'lobby.noTurnsBody':
    'All players look at the same cards at once and race to claim a SET. Nobody waits for anybody.',

  'game.claim': 'Claim SET',
  'game.claimSelected': 'Claim SET ({count}/3)',
  'game.noSet': 'No SET on board',
  'game.deckLeft': '{count} left',
  'game.deckLeftLabel': '{count} cards left in the deck',
  'game.setsFound': '{count} found',
  'game.setsFoundLabel': '{count} SETs found so far',
  'game.scoresLabel': 'Scores',
  'game.playerScore': '{name}: {score}',
  'game.cooldown': 'Wait {seconds}s',
  'game.selectThree': 'Select three cards',
  'game.fourthBlocked': 'You can only pick three cards. Tap a selected card to unpick it.',
  'game.cardLabel': '{count} {fill} {color} {shape}',
  'game.selectedPosition': 'selected, position {index} of 3',
  'game.boardLabel': 'Game board, {count} cards',
  'game.leave': 'Leave game',
  'game.leaveConfirm': 'Tap again to leave',

  'feed.setFound': '{name} found a SET +1',
  'feed.setFoundYou': 'You found a SET +1',
  'feed.invalidClaim': "{name}'s claim was not a SET",
  'feed.invalidClaimYou': 'Not a SET',
  'feed.cardsAdded': '3 cards added',
  'feed.noSetRejected': '{name} called no SET, but there is one',
  'feed.playerJoined': '{name} joined',
  'feed.playerLeft': '{name} left',
  'feed.playerDisconnected': '{name} lost connection',
  'feed.playerReconnected': '{name} is back',
  'feed.hostChanged': '{name} is now the host',
  'feed.gameStarted': 'Game on!',
  'feed.rematchWanted': '{name} wants a rematch',

  'reject.notASet': 'Not a SET: {repeated} twice and {odd} once ({attribute}).',
  'reject.notASetGeneric': 'That is not a SET.',
  'reject.boardChanged': 'The board changed — try again.',
  'reject.cooldown': 'Just a moment — wait for the timer.',
  'reject.notPlaying': 'The game is not running.',
  'reject.invalidCards': 'Pick three different cards on the board.',
  'reject.setExists': 'There is still a SET on the board.',

  'attribute.count': 'number',
  'attribute.shape': 'shape',
  'attribute.color': 'colour',
  'attribute.fill': 'shading',

  'value.count.one': 'one',
  'value.count.two': 'two',
  'value.count.three': 'three',
  'value.shape.oval': 'oval',
  'value.shape.diamond': 'diamond',
  'value.shape.squiggle': 'squiggle',
  // Separate plural forms rather than an appended "s", so a locale with its own
  // plural rules (Hebrew, for example) can translate them independently.
  'value.shapePlural.oval': 'ovals',
  'value.shapePlural.diamond': 'diamonds',
  'value.shapePlural.squiggle': 'squiggles',
  'value.color.red': 'red',
  'value.color.green': 'green',
  'value.color.purple': 'purple',
  // English does not inflect these, but Hebrew and many others do, so the plural
  // slot exists for every attribute that a card label pluralises.
  'value.colorPlural.red': 'red',
  'value.colorPlural.green': 'green',
  'value.colorPlural.purple': 'purple',
  'value.fill.open': 'open',
  'value.fill.striped': 'striped',
  'value.fill.solid': 'solid',
  'value.fillPlural.open': 'open',
  'value.fillPlural.striped': 'striped',
  'value.fillPlural.solid': 'solid',

  'results.title': 'Final scores',
  'results.winner': '{name} wins!',
  'results.winnerYou': 'You win!',
  'results.tie': "It's a tie: {names}",
  'results.setsFound': '{count} SETs',
  'results.playAgain': 'Play again',
  'results.startRematch': 'Start rematch',
  'results.waitingForHost': 'Waiting for {name} to start a rematch…',
  'results.wantsRematch': 'ready',
  'results.leave': 'Leave room',

  'tutorial.title': 'How to play',
  'tutorial.intro':
    'A SET is three cards where each of the four features is either all the same or all different.',
  'tutorial.features': 'Every card has four features:',
  'tutorial.featureCount': 'Number — one, two or three symbols',
  'tutorial.featureShape': 'Shape — oval, diamond or squiggle',
  'tutorial.featureColor': 'Colour — red, green or purple',
  'tutorial.featureFill': 'Shading — open, striped or solid',
  'tutorial.validSameHeading': 'Valid — same shape, colour and shading; one, two, three symbols',
  'tutorial.validAllDiffHeading': 'Valid — every single feature is different',
  'tutorial.invalidHeading': 'Not a SET — two purple and one green',
  'tutorial.invalidWhy': 'If even one feature has two the same and one different, it is not a SET.',
  'tutorial.flowTitle': 'How a game runs',
  'tutorial.flowTurns':
    'There are no turns. Everyone plays at the same time, on the same twelve cards, and the first correct claim wins them.',
  'tutorial.flowClaim':
    'Tap three cards, then “Claim SET”. Correct scores you a point. Wrong pauses you alone for 5 seconds — everyone else keeps playing.',
  'tutorial.flowRefill':
    'The board refills itself back to twelve from the deck, so there are almost always twelve cards in front of you.',
  'tutorial.flowNoSet':
    'If nobody can find a SET, anyone may tap “No SET on board”. If the board really has none, three more cards are added (fifteen, then eighteen) and no card is replaced until it is back down to twelve.',
  'tutorial.flowDeck':
    'The counter at the top left shows how many cards are still in the deck, out of 81. The game ends when the deck is empty and no SET is left. Most SETs wins; an equal score is a tie.',
  'tutorial.gotIt': 'Got it',
  'settings.language': 'Language',

  'settings.title': 'Display',
  'settings.colorAssist': 'Colour-blind labels',
  'settings.colorAssistHint': 'Show R / G / P letters on each card.',

  'status.connecting': 'Connecting…',
  'status.reconnecting': 'Reconnecting… ({attempt})',
  'status.offline': 'You are offline. Waiting for the network…',
  'status.reconnected': 'Back online',

  'error.title': 'Something went wrong',
  'error.roomNotFound': 'That room code does not exist. Check the code and try again.',
  'error.roomFull': 'That room is full.',
  'error.gameAlreadyStarted': 'That game has already started.',
  'error.notAuthorized': 'That seat belongs to another player. Rejoin to get a new one.',
  'error.roomClosed': 'That room has closed.',
  'error.versionMismatch': 'This page is out of date. Reload to get the latest version.',
  'error.network': 'Cannot reach the game server. Check your connection and try again.',
  'error.backendUnconfigured':
    'This build has no game server configured. Set VITE_API_BASE at build time.',
  'error.originNotAllowed':
    'The game server is not set up for this address. Add it to ALLOWED_ORIGINS on the Worker.',
  'error.generic': 'Something went wrong. Please try again.',
  'error.lostConnection': 'Connection lost. Trying to get you back in…',
  'error.rejoin': 'Rejoin',
  'error.reload': 'Reload',
} as const;

export type StringKey = keyof typeof en;
