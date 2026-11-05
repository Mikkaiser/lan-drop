// Which way a connection actually goes: straight across the local network, directly over the
// internet, or through the relay. Also whether this browser hides its local address (Chrome's
// default), which is the usual reason devices on the same network end up on the relay.

const PRIVATE_IP = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fc|fd|fe80:)/i;

export const ROUTE_LABEL = { lan: 'direct · same network', internet: 'direct · internet', relay: 'via relay' };

/** The candidate pair WebRTC chose for a PeerJS connection: { ip, type, localType } or null. */
export async function chosenAddress(conn) {
  const pc = conn.peerConnection;
  if (!pc) return null;
  const stats = await pc.getStats();
  let pair = null;
  stats.forEach(r => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId); });
  if (!pair) stats.forEach(r => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
  const remote = pair && stats.get(pair.remoteCandidateId);
  if (!remote) return null;
  const local = stats.get(pair.localCandidateId);
  return { ip: remote.address || remote.ip || '', type: remote.candidateType, localType: local?.candidateType };
}

/**
 * 'lan' | 'internet' | 'relay' | null, from chosenAddress(). samePublicIp: the other device is
 * behind the same router (so a direct internet-style route is really the local network).
 */
export function routeOf(address, samePublicIp = false) {
  if (!address) return null;
  if (address.type === 'relay' || address.localType === 'relay') return 'relay';
  const ip = address.ip || '';
  if (address.type === 'host' || PRIVATE_IP.test(ip) || ip.endsWith('.local')) return 'lan';
  return samePublicIp ? 'lan' : 'internet';
}

/**
 * Does this browser hide its local address behind a random ".local" name?
 * 'hidden' | 'shown' | 'unknown'
 */
export async function localAddressMode() {
  try {
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.createDataChannel('probe');
    const found = [];
    pc.onicecandidate = e => {
      const c = e.candidate;
      if (c && (c.type === 'host' || / typ host /.test(c.candidate))) found.push(c.address || c.candidate.split(' ')[4] || '');
    };
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise(resolve => {
      pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && resolve();
      setTimeout(resolve, 3000);
    });
    pc.close();
    if (!found.length) return 'unknown';
    return found.every(a => a.endsWith('.local')) ? 'hidden' : 'shown';
  } catch {
    return 'unknown';
  }
}
