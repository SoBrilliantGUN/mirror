import type { ReactNode } from 'react';
import './globals.css';
import StatusBar from './StatusBar';

export const metadata = { title: 'mirror' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh">
      <body>
        <div className="desktop">
          <div className="phone">
            <StatusBar />
            <div className="phone-screen">{children}</div>
            <div className="home-indicator" />
          </div>
        </div>
      </body>
    </html>
  );
}
