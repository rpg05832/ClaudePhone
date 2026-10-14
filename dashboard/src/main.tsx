import { createRoot } from 'react-dom/client';
import App from './App';
import '@fontsource/ibm-plex-sans-hebrew/400.css';
import '@fontsource/ibm-plex-sans-hebrew/500.css';
import '@fontsource/ibm-plex-sans-hebrew/600.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);
