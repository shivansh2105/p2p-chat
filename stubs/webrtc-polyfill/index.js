// No native WebRTC on desktop BitTorrent (see package.json). WebTorrent detects
// typeof RTCPeerConnection !== 'function' and simply disables WebRTC peers.
export const RTCPeerConnection = undefined
export const RTCSessionDescription = undefined
export const RTCIceCandidate = undefined
export default {}
