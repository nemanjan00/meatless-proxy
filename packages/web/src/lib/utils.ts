import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/** tailwind-merge that knows the stylebook's type scale (text-tiny … text-title3) is font sizes, not colours. */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['tiny', 'micro', 'mini', 'small', 'regular', 'title1', 'title2', 'title3'],
    },
  },
})

/** Merges class names, resolving Tailwind conflicts (shadcn's `cn`). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
