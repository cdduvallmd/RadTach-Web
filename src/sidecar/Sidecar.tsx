import { AuthProvider, useAuth } from '../contexts/AuthContext';
import LoginScreen from './components/LoginScreen';
import SessionGate from './components/SessionGate';

function SidecarInner() {
  const { currentUser } = useAuth();

  if (!currentUser) {
    return <LoginScreen />;
  }

  return <SessionGate />;
}

export default function Sidecar() {
  return (
    <AuthProvider>
      <SidecarInner />
    </AuthProvider>
  );
}
