'use strict';

const CHALLENGE_LENGTH = 5;
const CHALLENGE_EMOTES = Object.freeze([
  'EmoteGreeting',
  'EmoteClap',
  'EmotePoint',
  'EmoteSalute',
  'EmoteSurrender',
  'EmoteSitA',
  'EmoteDance',
  'EmoteHeart',
  'EmoteThumb',
  'EmoteTimeout',
]);

const EMOTE_LABELS = Object.freeze({
  EmoteGreeting: 'Wave',
  EmoteClap: 'Clap',
  EmotePoint: 'Point',
  EmoteSalute: 'Salute',
  EmoteSurrender: 'Surrender',
  EmoteSitA: 'Sit',
  EmoteDance: 'Dance',
  EmoteHeart: 'Heart',
  EmoteThumb: 'Thumbs up',
  EmoteTimeout: 'Time out',
});

function createEmoteChallengeSequence(random = Math.random) {
  const choices = [...CHALLENGE_EMOTES];
  const sequence = [];
  while (sequence.length < CHALLENGE_LENGTH) {
    const index = Math.floor(random() * choices.length);
    sequence.push(choices.splice(index, 1)[0]);
  }
  return sequence;
}

function evaluateEmoteChallenge(sequence, events, startedAt, expiresAt) {
  const startedMs = new Date(startedAt).getTime();
  const expiresMs = new Date(expiresAt).getTime();
  const observed = events
    .filter(event => {
      const timestamp = new Date(event.timestamp).getTime();
      return timestamp >= startedMs && timestamp <= expiresMs && sequence.includes(event.emote_type);
    })
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    .map(event => event.emote_type)
    .slice(0, sequence.length);

  return {
    verified: observed.length === sequence.length
      && observed.every((emote, index) => emote === sequence[index]),
    observed,
  };
}

function formatEmoteSequence(sequence) {
  return sequence.map((emoteType, index) => ({
    position: index + 1,
    emoteType,
    label: EMOTE_LABELS[emoteType] || emoteType,
  }));
}

module.exports = {
  CHALLENGE_LENGTH,
  CHALLENGE_EMOTES,
  createEmoteChallengeSequence,
  evaluateEmoteChallenge,
  formatEmoteSequence,
};
