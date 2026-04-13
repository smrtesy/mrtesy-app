import { redirect } from "next/navigation";

export default function LocaleHomePage({
  params: { locale },
}: {
  params: { locale: string };
}) {
  redirect(`/${locale}/login`);
}
