export function sanitizeFilenamePart(input: string): string {
  return (input || '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/-+/g, '-')
    .replace(/_+/g, '_')
    .replace(/^[-_]+|[-_]+$/g, '');
}

