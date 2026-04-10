export function buildPoseUrl(
  text: string,
  spokenLanguage: string,
  signedLanguage: string
): string {
  const trimmedText = text.trim();

  const api =
    "https://us-central1-sign-mt.cloudfunctions.net/spoken_text_to_signed_pose";

  const params = new URLSearchParams({
    text: trimmedText,
    spoken: spokenLanguage,   // ✅ CORRECT
    signed: signedLanguage,   // ✅ CORRECT
  });

  return `${api}?${params.toString()}`;
}