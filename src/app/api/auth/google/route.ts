import { NextResponse } from "next/server";

// OAuth initiate for Gmail/Calendar/Drive (separate from login)
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const service = searchParams.get("service"); // 'gmail_calendar' | 'drive'

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/google/callback`;

  let scopes: string;
  let state: string;

  switch (service) {
    case "gmail_calendar":
      scopes =
        "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar";
      state = "gmail_calendar";
      break;
    case "drive":
      scopes = "https://www.googleapis.com/auth/drive.readonly";
      state = "drive";
      break;
    default:
      return NextResponse.json({ error: "Invalid service" }, { status: 400 });
  }

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId!);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scopes);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");

  return NextResponse.redirect(authUrl.toString());
}
