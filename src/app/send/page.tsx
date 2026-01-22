'use client';
import { useEffect, useRef, useState } from 'react';

export default function SendPage() {
  const wsRef = useRef<WebSocket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const roomRef = useRef('');
  const [room, setRoom] = useState('');
  const [connected, setConnected] = useState(false);
  const [progress, setProgress] = useState(0);


  useEffect(() => {
    const ws = new WebSocket('wss://airdropbackend-jv96.onrender.com');
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('✅ WebSocket connected (sender)');
    };

    ws.onmessage = async (e) => {
        const msg = JSON.parse(e.data);
        console.log('[Sender] Received message:', msg);
      
        if (msg.type === 'peer-joined') {
          console.log('[Sender] Receiver has joined! Creating offer...');
          startConnection(room); // ✅ Now it's safe to start connection
        }
      
        if (msg.type === 'answer') {
          await peerRef.current?.setRemoteDescription(new RTCSessionDescription(msg.answer));
        }
      
        if (msg.type === 'ice-candidate') {
          await peerRef.current?.addIceCandidate(new RTCIceCandidate(msg.candidate));
        }
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // ✅ run once

  const createRoom = () => {
    const roomCode = Math.random().toString(36).substring(2, 8);
    setRoom(roomCode);
  
    const waitForWebSocket = () => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'join', room: roomCode }));
        startConnection(roomCode);
      } else {
        setTimeout(waitForWebSocket, 100); // Check again after 100ms
      }
    };
  
    waitForWebSocket();
  };
  

  const startConnection = async (roomCode: string) => {
    console.log('[TURN Config] Attempting to use TURN server: turn:13.126.43.172:3478');
    const peer = new RTCPeerConnection({
      iceServers: [
        { urls:[
          'stun:stun.l.google.com:19302' ,
          "stun:global.stun.twilio.com:3478"
        ] 
      },
      // Try multiple TURN server formats for compatibility
      {
        urls: 'turn:13.126.43.172:3478?transport=udp',
        username: 'turnuser',
        credential: 'turnpassword'
      },
      {
        urls: 'turn:13.126.43.172:3478?transport=tcp',
        username: 'turnuser',
        credential: 'turnpassword'
      },
      {
        urls: 'turn:13.126.43.172:3478',
        username: 'turnuser',
        credential: 'turnpassword'
      }
      ],
    });   
    
    
    peerRef.current = peer;

    let hasRelayCandidate = false;
    let candidateCount = { host: 0, srflx: 0, relay: 0 };

    // Diagnostic: Monitor ICE gathering state
    peer.onicegatheringstatechange = () => {
      console.log(`[ICE Gathering State] ${peer.iceGatheringState}`);
      if (peer.iceGatheringState === 'complete') {
        console.log(`[ICE Candidates Summary] Host: ${candidateCount.host}, STUN: ${candidateCount.srflx}, TURN: ${candidateCount.relay}`);
        if (!hasRelayCandidate) {
          console.warn('⚠️ WARNING: No TURN relay candidates found!');
          console.warn('⚠️ Possible issues:');
          console.warn('   - TURN server may be unreachable');
          console.warn('   - TURN credentials may be incorrect');
          console.warn('   - TURN server may not be running');
          console.warn('   - Firewall may be blocking port 3478');
          console.warn('   - TURN server URL format may be incorrect');
        }
      }
    };

    // Diagnostic: Monitor ICE connection state
    peer.oniceconnectionstatechange = () => {
      console.log(`[ICE State] ${peer.iceConnectionState}`);
      if (peer.iceConnectionState === 'failed' || peer.iceConnectionState === 'disconnected') {
        console.error('❌ ICE connection failed');
        if (!hasRelayCandidate) {
          console.error('❌ TURN server was not used - connection may fail behind NAT/firewall');
        }
      }
      if (peer.iceConnectionState === 'connected' || peer.iceConnectionState === 'completed') {
        if (hasRelayCandidate) {
          console.log('✅ Connected via TURN server');
        } else {
          console.log('✅ Connected (direct or via STUN)');
        }
      }
    };

    // Diagnostic: Monitor connection state
    peer.onconnectionstatechange = () => {
      console.log(`[Connection State] ${peer.connectionState}`);
    };

    // Diagnostic: Check ICE candidate types
    peer.onicecandidate = (e) => {
      if (e.candidate) {
        const candidate = e.candidate.candidate;
        const candidateType = e.candidate.type;
        console.log(`[ICE Candidate] Type: ${candidateType}, Candidate: ${candidate}`);
        
        // Track candidate types
        candidateCount[candidateType as keyof typeof candidateCount]++;
        
        // Check if it's a relay candidate (TURN server)
        if (candidateType === 'relay') {
          hasRelayCandidate = true;
          console.log('✅ TURN server is being used (relay candidate found)');
        } else if (candidateType === 'srflx') {
          console.log('ℹ️ Using STUN server (server reflexive candidate)');
        } else if (candidateType === 'host') {
          console.log('ℹ️ Using local candidate');
        }

        wsRef.current?.send(JSON.stringify({
          type: 'signal',
          room: roomCode,
          data: { type: 'ice-candidate', candidate: e.candidate },
        }));
      } else {
        console.log('✅ ICE gathering complete');
        if (!hasRelayCandidate) {
          console.warn('⚠️ No TURN relay candidates were generated');
        }
      }
    };

    const channel = peer.createDataChannel('file');
    dataChannelRef.current = channel;

    channel.onopen = () => {
      console.log('[DataChannel] Open (sender)');
      setConnected(true);
    };

    channel.onerror = (e) => console.error('DataChannel error (sender):', e);

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);

    wsRef.current?.send(JSON.stringify({
      type: 'signal',
      room: roomRef.current,
      data: { type: 'offer', offer },
    }));
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const dataChannel = dataChannelRef.current;
  
    if (!file || !dataChannel || dataChannel.readyState !== 'open') return;

    // Check file size (10GB limit)
    const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024; // 10GB
    if (file.size > MAX_FILE_SIZE) {
      alert(`File size (${(file.size / 1024 / 1024 / 1024).toFixed(2)}GB) exceeds the 10GB limit`);
      return;
    }

    // Optimized for large files (10GB support)
    // Larger chunk size for better throughput on large files
    const CHUNK_SIZE = 128 * 1024; // 128KB - good balance for large files
    const MAX_BUFFER = 8 * 1024 * 1024; // 8MB buffer for large file transfers
    const LOW_WATER_MARK = 4 * 1024 * 1024; // 4MB low water mark
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    let sentChunks = 0;

    console.log(`📤 Starting transfer: ${file.name} (${(file.size / 1024 / 1024 / 1024).toFixed(2)}GB)`);

    // Set the low water mark threshold
    dataChannel.bufferedAmountLowThreshold = LOW_WATER_MARK;
  
    // Send file metadata
    try {
      dataChannel.send(JSON.stringify({
        type: 'file-meta',
        name: file.name,
        size: file.size,
        fileType: file.type,
      }));
    } catch (err) {
      console.error('🚫 Failed to send file metadata:', err);
      return;
    }
  
    let offset = 0;
    const startTime = Date.now();
  
    const waitForDrain = (): Promise<void> => {
      return new Promise<void>((resolve) => {
        // Check if buffer is already low
        if (dataChannel.bufferedAmount < LOW_WATER_MARK) {
          resolve();
          return;
        }
        
        // Set up event listener for buffer drain
        const handler = () => {
          dataChannel.removeEventListener('bufferedamountlow', handler);
          resolve();
        };
        dataChannel.addEventListener('bufferedamountlow', handler);
        
        // Safety timeout - resolve after 5 seconds even if event doesn't fire
        setTimeout(() => {
          dataChannel.removeEventListener('bufferedamountlow', handler);
          console.warn('⚠️ Buffer drain timeout, continuing anyway');
          resolve();
        }, 5000);
      });
    };
  
    while (offset < file.size) {
      // Check buffer before reading the next chunk
      if (dataChannel.bufferedAmount > MAX_BUFFER) {
        console.log(`⏳ Buffer full (${(dataChannel.bufferedAmount / 1024 / 1024).toFixed(2)}MB), waiting for drain...`);
        await waitForDrain();
      }
      
      // Read chunk
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      const buffer = await slice.arrayBuffer();
  
      // Double-check buffer before sending
      if (dataChannel.bufferedAmount > MAX_BUFFER) {
        await waitForDrain();
      }
  
      // Try to send with retry logic
      let retries = 3;
      let sent = false;
      
      while (retries > 0 && !sent) {
        try {
          // Check if channel is still open
          if (dataChannel.readyState !== 'open') {
            console.error('❌ DataChannel closed during send');
            return;
          }
          
          dataChannel.send(new Uint8Array(buffer));
          sent = true;
        } catch (err: any) {
          retries--;
          if (err.name === 'OperationError' && err.message?.includes('queue is full')) {
            console.warn(`⚠️ Send queue full, waiting... (${retries} retries left)`);
            await waitForDrain();
            // Wait a bit more before retrying
            await new Promise(resolve => setTimeout(resolve, 100));
          } else {
            console.error('🚫 Send failed:', err);
            return;
          }
        }
      }
      
      if (!sent) {
        console.error('❌ Failed to send chunk after retries');
        return;
      }
  
      offset += CHUNK_SIZE;
      sentChunks++;
      const progressPercent = Math.floor((sentChunks / totalChunks) * 100);
      setProgress(progressPercent);
      
      // Log less frequently for large files to reduce overhead
      // For files > 1GB, log every 100 chunks; otherwise every 10 chunks
      const logInterval = file.size > 1024 * 1024 * 1024 ? 100 : 10;
      if (sentChunks % logInterval === 0 || progressPercent === 100) {
        const sentMB = (offset / 1024 / 1024).toFixed(2);
        const totalMB = (file.size / 1024 / 1024).toFixed(2);
        const speed = sentChunks > 0 ? (offset / (Date.now() - startTime) * 1000 / 1024 / 1024).toFixed(2) : '0';
        console.log(`📦 ${progressPercent}% - ${sentMB}MB / ${totalMB}MB @ ${speed}MB/s`);
      }
    }
  
    // Wait for buffer to drain before sending EOF
    if (dataChannel.bufferedAmount > 0) {
      console.log('⏳ Waiting for final buffer drain before EOF...');
      await waitForDrain();
    }
  
    try {
      dataChannel.send(JSON.stringify({ type: 'eof' }));
      console.log('✅ File send complete');
    } catch (err) {
      console.error('🚫 Failed to send EOF:', err);
    }
  };
  
  

  return (
    <div className="p-6 text-center">
      <h2 className="text-2xl font-bold mb-4">Send File</h2>
      {room ? <p className="mb-2">Room Code: <code>{room}</code></p> : (
        <button onClick={createRoom} className="px-4 py-2 bg-blue-500 text-white rounded-xl">Create Room</button>
      )}
      {connected ? (<>
        <input 
          type="file" 
          onChange={handleFile} 
          className="block mx-auto mt-6" 
          accept="*/*"
        />
        <p className="text-xs text-gray-500 mt-2">Supports files up to 10GB</p>
        {progress > 0 && progress < 100 && (
          <div className="mt-4">
            <div className="w-full bg-gray-200 rounded-full h-4">
              <div
                className="bg-blue-500 h-4 rounded-full transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="text-sm text-gray-600 mt-2">{progress}%</p>
          </div>
        )}
        {progress === 100 && <p className="mt-2 text-green-600">✅ File Sent</p>}
        </>
        
      ) : (
        <p className="text-sm text-gray-500 mt-6">Waiting for connection...</p>
      )}
    </div>
  );
}
