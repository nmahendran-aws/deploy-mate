import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Repo2Cloud — Automated AWS Deployment Platform | Technica 2026',
  description:
    'Submit a GitHub repository, detect the stack, provision S3 + CloudFront, ECS Fargate, Lambda, or Amplify, and configure a branded Route 53 HTTPS subdomain.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-[#070b14] text-slate-100 antialiased">
        {children}
      </body>
    </html>
  );
}
