/**
 * Environment profiles: ready-made images with a toolkit for a kind of work, offered to env.up by
 * name. The built-in catalog is nemanjan00/dev (https://github.com/nemanjan00/dev-environment): one
 * Arch Linux base (git, Node.js, Python, zsh, Neovim, the usual CLI tools) with a profile per domain on
 * top. A deployment replaces or extends it with `ENV_PROFILES`.
 */
export interface EnvProfile {
  name: string
  image: string
  /** One line: what it's for and its main tools, shown to the model. */
  description: string
}

export const DEFAULT_ENV_PROFILES: readonly EnvProfile[] = [
  { name: 'default', image: 'nemanjan00/dev:default', description: 'general work: git, Node.js, Python, the usual CLI tools' },
  {
    name: 'analyst',
    image: 'nemanjan00/dev:analyst',
    description: 'data and infra: psql, mariadb, sqlite, duckdb, mongosh, valkey-cli, aws-cli, rclone, httpie, yq, ffmpeg',
  },
  {
    name: 'librarian',
    image: 'nemanjan00/dev:librarian',
    description: 'documents: pandoc, pdftotext, qpdf, pdfgrep, tesseract OCR, catdoc',
  },
  {
    name: 'multimedia',
    image: 'nemanjan00/dev:multimedia',
    description: 'audio, video and images: ffmpeg, imagemagick, sox, exiftool, mediainfo',
  },
  { name: 'presenter', image: 'nemanjan00/dev:presenter', description: 'slide decks from Markdown: pandoc, beamer, xelatex' },
  {
    name: 'scraper',
    image: 'nemanjan00/dev:scraper',
    // Found live: no Chromium binary and no browsers for Playwright in the image; cloakbrowser is installed.
    description:
      'web scraping: cloakbrowser (a stealth Chromium) is installed; Playwright/Puppeteer need their browser installed first (e.g. npx playwright install chromium, with network)',
  },
  {
    name: 'reversing',
    image: 'nemanjan00/dev:reversing',
    description: 'reverse engineering: radare2, jadx, apktool, binwalk, adb, volatility3',
  },
  {
    name: 'ctf',
    image: 'nemanjan00/dev:ctf',
    description: 'binary exploitation: pwntools, GEF, ROPgadget, plus reversing tools',
  },
  {
    name: 'emulation',
    image: 'nemanjan00/dev:emulation',
    description: 'foreign-arch binaries and firmware: qemu (system and user mode), UEFI firmware',
  },
  {
    name: 'embedded',
    image: 'nemanjan00/dev:embedded',
    description: 'embedded: arm-none-eabi, platformio, esptool, openocd, avrdude',
  },
  { name: 'android', image: 'nemanjan00/dev:android', description: 'Android/AOSP builds: repo, JDK 17/11, ccache' },
  { name: 'android-app', image: 'nemanjan00/dev:android-app', description: 'Android apps: Android SDK, JDK 17, Gradle, adb' },
  { name: 'php', image: 'nemanjan00/dev:php', description: 'PHP 8 and Composer' },
  { name: 'maker', image: 'nemanjan00/dev:maker', description: 'maker work: OpenSCAD, tscircuit' },
]

/** A profile by name, from the configured catalog. */
export function envProfile(profiles: readonly EnvProfile[], name: string | undefined): EnvProfile | undefined {
  return name ? profiles.find((p) => p.name === name) : undefined
}

/** The catalog in one line per profile, for a tool description. */
export function describeProfiles(profiles: readonly EnvProfile[]): string {
  return profiles.map((p) => `${p.name} (${p.description})`).join('; ')
}
