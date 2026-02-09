import { getRequestConfig } from "next-intl/server";

export type SupportedLocale = "en" | "he" | "ru";

export const supportedLocales: SupportedLocale[] = ["en", "he", "ru"];
export const defaultLocale: SupportedLocale = "en";

export const rtlLocales: SupportedLocale[] = ["he"];

export function isRtl(locale: string): boolean {
  return rtlLocales.includes(locale as SupportedLocale);
}

export function resolveLocale(languageCode?: string | null): SupportedLocale {
  if (languageCode && supportedLocales.includes(languageCode as SupportedLocale)) {
    return languageCode as SupportedLocale;
  }
  return defaultLocale;
}

export async function getMessages(locale: SupportedLocale) {
  return (await import(`@/messages/${locale}.json`)).default;
}

export default getRequestConfig(async () => {
  const locale = defaultLocale;
  return {
    locale,
    messages: await getMessages(locale),
  };
});
