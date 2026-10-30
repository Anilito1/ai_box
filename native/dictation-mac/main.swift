// Dictation helper of AI Box: Apple's SpeechAnalyzer (macOS 26+), on-device.
//
//   dictation-mac [--locale fr-FR] [--term WORD]...   dictate: audio on stdin, JSON lines on stdout
//   dictation-mac --check [--locale fr-FR]            report whether the voice asset is there, then exit
//
// stdin: raw PCM, 16-bit signed little-endian, 16 kHz, mono. End of input ends the dictation.
// stdout, one JSON object per line:
//   {"type":"ready"}                       models loaded, audio is welcome
//   {"type":"partial","text":"…"}          the whole dictation so far (settled text + the guess being revised)
//   {"type":"final","text":"…"}            the settled text, once the input has ended; then the process exits
//   {"type":"error","code":"…","message":"…"}
//   {"type":"check","available":bool,"installed":bool,"locale":"fr-FR"}
// --term words go to AnalysisContext.contextualStrings: names and jargon the model should favour.

import AVFoundation
import Foundation
import Speech

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes]) else { return }
  var line = data
  line.append(0x0A)
  FileHandle.standardOutput.write(line)
}

func fail(_ code: String, _ message: String) -> Never {
  emit(["type": "error", "code": code, "message": message])
  exit(1)
}

var localeId = "fr-FR"
var terms: [String] = []
var checkOnly = false
var args = CommandLine.arguments.dropFirst()
while let arg = args.popFirst() {
  switch arg {
  case "--locale": if let v = args.popFirst() { localeId = v }
  case "--term": if let v = args.popFirst(), !v.isEmpty { terms.append(v) }
  case "--check": checkOnly = true
  default: break
  }
}

guard #available(macOS 26.0, *) else { fail("unsupported", "macOS 26 or later is required") }

@available(macOS 26.0, *)
func run() async {
  guard SpeechTranscriber.isAvailable else { fail("unavailable", "Speech transcription is not available on this Mac") }
  guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: localeId)) else {
    fail("locale", "Unsupported language: \(localeId)")
  }
  let installed = await SpeechTranscriber.installedLocales.contains { $0.identifier(.bcp47) == locale.identifier(.bcp47) }
  if checkOnly {
    emit(["type": "check", "available": true, "installed": installed, "locale": locale.identifier(.bcp47)])
    exit(0)
  }

  let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [])
  do {
    if !installed, let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
      try await request.downloadAndInstall()
    }
  } catch {
    fail("asset", "Could not install the voice asset: \(error.localizedDescription)")
  }

  guard let target = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else { fail("format", "No audio format for this language") }
  guard let source = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true),
    let converter = AVAudioConverter(from: source, to: target)
  else { fail("format", "Cannot convert the audio") }

  let context = AnalysisContext()
  if !terms.isEmpty { context.contextualStrings = [.general: terms] }
  let (inputs, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
  let analyzer = SpeechAnalyzer(inputSequence: inputs, modules: [transcriber], options: .init(priority: .userInitiated, modelRetention: .whileInUse), analysisContext: context)

  // Results: settled text accumulates; the volatile guess is replaced by each new result.
  let results = Task { () -> String in
    var settled = ""
    do {
      for try await result in transcriber.results {
        let text = String(result.text.characters)
        if result.isFinal {
          settled += text
          emit(["type": "partial", "text": settled])
        } else {
          emit(["type": "partial", "text": settled + text])
        }
      }
    } catch {
      fail("recognition", error.localizedDescription)
    }
    return settled
  }

    emit(["type": "ready"])

  // Audio: 100 ms of Int16 at a time, converted to the format the analyzer wants.
  let chunkBytes = 3200
  let stdin = FileHandle.standardInput
  var pending = Data()
  func feed(_ bytes: Data) {
    let frames = AVAudioFrameCount(bytes.count / 2)
    guard frames > 0, let input = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: frames) else { return }
    input.frameLength = frames
    bytes.withUnsafeBytes { raw in
      if let base = raw.baseAddress { memcpy(input.int16ChannelData![0], base, Int(frames) * 2) }
    }
    let capacity = AVAudioFrameCount(Double(frames) * target.sampleRate / source.sampleRate) + 64
    guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
    var supplied = false
    var err: NSError?
    converter.convert(to: output, error: &err) { _, status in
      if supplied {
        status.pointee = .noDataNow
        return nil
      }
      supplied = true
      status.pointee = .haveData
      return input
    }
    if err == nil, output.frameLength > 0 { continuation.yield(AnalyzerInput(buffer: output)) }
  }
  while true {
    let data = stdin.readData(ofLength: chunkBytes)
    if data.isEmpty { break }
    pending.append(data)
    let usable = pending.count - pending.count % 2
    if usable > 0 {
      feed(pending.prefix(usable))
      pending.removeFirst(usable)
    }
  }
  continuation.finish()
  do { try await analyzer.finalizeAndFinishThroughEndOfInput() } catch { fail("finish", error.localizedDescription) }
  let text = await results.value
  emit(["type": "final", "text": text])
  exit(0)
}

if #available(macOS 26.0, *) {
  Task { await run() }
  dispatchMain()
}
