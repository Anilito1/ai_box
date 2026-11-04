// Run from the repository root: swift scripts/macos-icon.swift
// Deterministic bitmap scaling only: preserve the existing artwork, including its alpha.
import AppKit
import ImageIO

func load(_ path: String) -> CGImage {
    let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil)!
    return CGImageSourceCreateImageAtIndex(source, 0, nil)!
}

func context(_ width: Int, _ height: Int) -> CGContext {
    CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
              bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
}

func save(_ image: CGImage, _ path: String) {
    let output = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, "public.png" as CFString, 1, nil)!
    CGImageDestinationAddImage(output, image, nil)
    precondition(CGImageDestinationFinalize(output))
}

let original = load("assets/icon.png")
precondition(original.width == 512 && original.height == 512)
let canvas = context(512, 512)
canvas.interpolationQuality = .high
// Match the optical footprint of a conventional macOS rounded-square tile:
// 412/512 = 80.47%, centered with 50 transparent pixels on each side.
canvas.draw(original, in: CGRect(x: 50, y: 50, width: 412, height: 412))
let scaled = canvas.makeImage()!
save(scaled, "assets/icon-macos.png")

// Same canvas and scale for each pair; small sizes expose loss of legibility.
let preview = context(1120, 780)
preview.setFillColor(CGColor(red: 0.90, green: 0.91, blue: 0.93, alpha: 1))
preview.fill(CGRect(x: 0, y: 390, width: 1120, height: 390))
preview.setFillColor(CGColor(red: 0.10, green: 0.11, blue: 0.14, alpha: 1))
preview.fill(CGRect(x: 0, y: 0, width: 1120, height: 390))
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(cgContext: preview, flipped: false)
func label(_ value: String, _ x: Int, _ y: Int, _ dark: Bool) {
    (value as NSString).draw(at: NSPoint(x: x, y: y), withAttributes: [
        .font: NSFont.systemFont(ofSize: 15), .foregroundColor: dark ? NSColor.white : NSColor.black,
    ])
}
for (bottom, dark) in [(390, false), (0, true)] {
    for (index, image) in [original, scaled].enumerated() {
        let x = 24 + index * 556
        label(index == 0 ? "Before / Avant — canvas 512 px" : "After / Après — canvas 512 px", x, bottom + 356, dark)
        preview.interpolationQuality = .high
        preview.draw(image, in: CGRect(x: x, y: bottom + 70, width: 256, height: 256))
        label("256 px", x, bottom + 40, dark)
        for (offset, size) in [(290, 128), (440, 64), (440, 32), (500, 16)] {
            let y = bottom + (size == 32 || size == 16 ? 100 : 210)
            preview.draw(image, in: CGRect(x: x + offset, y: y, width: size, height: size))
            label("\(size) px", x + offset, y - 25, dark)
        }
    }
}
NSGraphicsContext.restoreGraphicsState()
save(preview.makeImage()!, "docs/macos-icon-scale-preview.png")
print("Generated macOS icon (512², artwork 412²) and light/dark preview.")
