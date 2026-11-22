# SillyTavern Voice Mode

Spoken roleplay and hands-free voice conversation inside SillyTavern, uniting streaming speech playback, voice dictation, and natural spoken interruption across solo and group chats.

## Language

**Voice Mode**:
The unified conversational audio state combining spoken reply playback, microphone dictation, and spoken interruption within an active chat.
_Avoid_: Audio plugin, voice assistant, call mode

**Streaming Utterance**:
A speakable sentence or clause segmented from an in-flight character reply so speech begins before full reply generation finishes.
_Avoid_: Audio chunk, token fragment, partial message

**Voice Barge-In**:
A user's spoken interruption that immediately halts active speech playback and cancels any ongoing character reply generation.
_Avoid_: Cut-off, auto-stop, mic override

**Voice Map**:
The assignment table binding each character (or default fallback speaker) in a solo or group chat to a specific voice identity.
_Avoid_: Speaker table, character audio config, voicepreset list

**Character Voice**:
The distinct vocal timbre and synthesis profile assigned to a single character persona.
_Avoid_: Sound pack, narrator model, avatar voice

**Emotion Cue**:
An inline expressive annotation produced by a character reply to steer vocal delivery and prosody without being spoken literally.
_Avoid_: Stage tag, mood token, SSML wrapper

**Voice Daemon**:
An optional companion local speech service running on the user's machine that provides native offline synthesis and recognition across local clients.
_Avoid_: Backend server, Extras API, cloud worker

**Secure Origin**:
A browser origin permitted to capture microphone input (loopback or encrypted transport), required before hands-free dictation or Voice Barge-In can arm.
_Avoid_: Trusted tab, whitelisted host, HTTPS mode
