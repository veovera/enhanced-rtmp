/*

These are unofficial notes, to help keep track of the progress. It's meant to be simple and concise and is not meant to be a comprehensive official roadmap.

- take a look at _doRemoveRanges
- how is updating used in the code?

Now - debug webm generation
* fix webm blockgroup generation
* parse chunk sometimes is in a state of geeting wrong messge type>? 
* Fix test of key frames in webm-remuxer
* Isues with all key frames in flv
  - fix how much is buffered and displayed in mp4-remuxer
  - fix bbb with mp4-remuxer
* we do pop last frame in mp4-remuxer, why?
* fix dts out of order in webm-remuxer
* take a look at track.lengh - how is it used?
* take a look at https://www.chromium.org/developers/design-documents/video/
* document/explain the webm generation process in the code comments

To do 
* check to make sure we have the right amount of new for emitter so that events are not lost
* make sure we are not overusing the emitter, e.g. in mse-controller
* take a look at evenetEmitter usage, see if you can bottleneck it within logger?
* set witdth height when reading configuration record
* cleanup config options, make sure all modules that have config options are using the same config options
* make webm code path configurable and dynamic
* play audio only even if there is video
* take a look at mp4 remuxer, we pop a frame at the end and insrt it at the beginning, but it's not a key frame, is that ever and issue?
* we don't need to bind callbacks if we have a reference to the instance of a class (e.g. in remuxer)
* av1 webm
* check if ___DEBUG__ is used during production builds, if so, remove it
* vp9 webm
* vp8 webm
* opus webm
* flac webm
* make sure we handle dts out of order in webm-remuxer and mp4-remuxer
* play audio only flv
* play audio only even if there is video
* address !!@
* remove mpegts
  - remove mpegts-demuxer
  - remove mpegts-muxer
  - remove mpegts-parser
  - remove mpegts-remuxer
* fix compilation errors
* do we need av1.ts? change the header for it if we do
* remove native player?
* consolidate tsconfig.json
* remove destroy() from all classes, rely on garbage collection
* port mp4-generator to ts
* port mp4-remuxer to ts
* rename fileposition to filePosition
* Sometimes the DTS order problem causes the calculated sampleDuration to be negative, and the playback time suffix is 1193 hours (PR #266)

Done

*/