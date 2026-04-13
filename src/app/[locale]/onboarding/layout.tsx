export default function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4 py-8">
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-bold text-[#1E4D8C]">smrtesy</h1>
      </div>
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}
