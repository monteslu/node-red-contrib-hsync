const { createConnection } = require('hsync');
const queryString = require('node:querystring');

module.exports = function(RED) {
  const cons = {};
  const peerCons = {};

  function HsyncConnection(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const { hsyncSecret } = node.credentials;
    const { hsyncServer } = config;
    node.hsyncServer = hsyncServer;
    const hsu = new URL((hsyncServer + '').trim().toLowerCase());
    node.hsu = hsu;

    // console.log('hsyncServer', config, node.credentials, 'con', !!node.con);
    
    const oldCon = cons[hsu.hostname];
    const keepCon = (
      oldCon &&
      oldCon.config.hsyncSecret === hsyncSecret && 
      oldCon.config.hsyncServer === hsyncServer && 
      oldCon.config.localHost === config.localWebHost &&
      oldCon.config.port === config.localWebPort
    );

    const connectedFunc = () => {
      node.emit('hsync_connected');
    };

    const errorFunc = (e) => {
      console.error('hsync_error', e);
      node.emit('hysnc_error', e);
    };

    node.on('close', (removed, done) => {
      node.con.removeListener('connected', connectedFunc);
      node.con.removeListener('error', errorFunc);
      if (removed) {
        node.con.endClient(true);
        delete cons[hsu.hostname];
        console.log('oldcon node removed');
      } else {
        // This node is being restarted
        console.log('oldcon node restarted');
      }
      done();
    });

    if (keepCon) {
      node.con = oldCon;
      node.con.on('error', errorFunc);
    } else {
      if (oldCon) {
        oldCon.endClient(true);
        delete cons[hsu.hostname];
      }
      const conOptions = {
        hsyncServer,
        hsyncSecret,
        localhost: config.localWebHost,
        port: config.localWebPort,
      };
      
      createConnection(conOptions).then((con) => {
        // console.log('createConnection!!!!!!!!!!!!!!');
        node.emit('hsync_connecting');
        node.con = con;
        cons[hsu.hostname] = con;
  
        node.con.on('error', errorFunc);
        node.con.on('connected', connectedFunc);
  
      })
      .catch((e) => {
        console.log('error launching hsync', e, conOptions);
        node.error(e);
      });
    }

  }
  RED.nodes.registerType('hsync-connection', HsyncConnection, {
    credentials: {
      hsyncSecret: {type:'password',required:true}
    }
  });

  function HsyncPeer(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const { host } = config;
    const hsu = new URL((host + '').trim().toLowerCase());
    node.hsu = hsu;

    peerCons[hsu.hostname] = peerCons[hsu.hostname] || [];

    node.host = host;
    // console.log('HsyncPeer', config);

  }
  RED.nodes.registerType('hsync-peer', HsyncPeer);
  
  function HsyncOut(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const hsyncPeer = RED.nodes.getNode(config.peer);
    node.host = hsyncPeer.host;

    node.on('input', async function(msg) {
      let host = node.host;
      if (host && host.endsWith('/')) {
        host = host + '_hs/message';
      } else {
        host = host + '/_hs/message';
      }
      
      if (msg.query) {
        const qs = queryString.encode(msg.query);
        // console.log('hsync-out qs', qs);
        if (qs) {
          host = host + '?' + qs;
        }
      }
      
      let status;
      try {
        node.status({fill:'yellow',shape:'ring',text:'sending...'});
        const options = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            topic: msg.topic,
            payload: msg.payload,
          }),
        };
        // console.log('sending', host, options);
        const result = await fetch(host, options);
        const text = await result.text();
        status = result.status;
        if (status >= 400) {
          throw new Error(text);
        }
        node.status({fill:'green',shape:'dot',text:'sent'});

      } catch (e) {
        e.status = status;
        node.status({fill:'red',shape:'ring',text:'error'});
        node.error(e);
      }
    });
  }
  RED.nodes.registerType('hsync-out', HsyncOut);


  function HsyncIn(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const hsync = RED.nodes.getNode(config.connection);

    hsync.on('hsync_connecting', () => {
      node.status({fill:'yellow',shape:'ring',text:'connecting...'});
    });

    hsync.on('hsync_connected', () => {
      let host = 'connected';
      try {
        host = new URL(hsync.con.hsyncServer).hostname;
      } catch (e) {}
      node.status({fill:'green',shape:'dot',text: host});
    });
    
    hsync.on('hysnc_error', (e) => {
      node.status({fill:'red',shape:'ring',text:'error'});
      node.error(e);
    });

    hsync.con.on('json', (msg) => {
      node.send(msg);
    });

    hsync.con.on('external_message', (msg) => {
      // console.log('external_message', msg);
      node.send(msg);
    });
  }
  RED.nodes.registerType('hsync-in', HsyncIn);

  function HsyncP2PIn(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const hsync = RED.nodes.getNode(config.connection);
    const hsyncPeer = RED.nodes.getNode(config.peer);
    const conShortName = hsync.hsu.hostname.split('.')[0];
    const peerShortName = hsyncPeer.hsu.hostname.split('.')[0];

    if (hsyncPeer.hsu.hostname === hsync.hsu.hostname) {
      node.error('cannot connect to self');
      node.status({fill:'red',shape:'ring',text:'cannot connect to self'});
      return;
    }
    
    const peer = hsync.con.getPeer(hsyncPeer.host);
    peerCons[hsyncPeer.hsu.hostname] = peerCons[hsyncPeer.hsu.hostname] || peer;

    // console.log('peer', peer, peerCons);
    // console.log('HsyncP2PIn', hsyncPeer.host, '→', hsync.hsyncServer, peer.dcOpen, peer.rtcStatus);

    if (peer.dcOpen) {
      console.log('dcOpen already open', hsyncPeer.host);
      const text = `${peerShortName} → ${conShortName}`;
      node.status({fill:'green',shape:'dot',text});
    }

    peer.rtcEvents.on('dcOpen', () => { 
      // console.log('dcOpen to', hsyncPeer.host);
      const text = `${peerShortName} → ${conShortName}`;
      node.status({fill:'green',shape:'dot',text});
    });

    if (peer.rtcStatus === 'error') {
      // console.log('RTC ERROR', hsyncPeer.host);
      node.status({fill:'red',shape:'ring',text:'error'});
    }

    if (peer.rtcStatus === 'connecting') {
      // console.log('RTC CONNECTING', hsyncPeer.host);
      node.status({fill:'yellow',shape:'ring',text:'connecting...'});
    }

    peer.rtcEvents.on('error', () => { 
      node.status({fill:'red',shape:'dot',text:error.getMessage()});
    });

    peer.rtcEvents.on('closed', () => {
      node.status({fill:'red',shape:'ring',text:'closed'});
    });

    peer.rtcEvents.on('disconnected', () => {
      node.status({fill:'red',shape:'ring',text:'disconnected'});
    });

    peer.rtcEvents.on('jsonMsg', (msg) => {
      node.send(msg);
    });

    if (!peer.dcOpen && peer.rtcStatus !== 'connecting') {
      node.status({fill:'yellow',shape:'ring',text:'connecting...'});
      console.log('connecting rtc');
      peer.connectRTC()
      .then(() => {
        console.log('then, connected rtc');
      })
      .catch((e) => {
        console.log('err, connect rtc', e);
        node.error(e);
      });
    }

    // console.log('peer', peer);

    hsync.on('error', () => {
      node.status({fill:'red',shape:'ring',text:'error'});
    });

    // hsync.con.on('connected', () => {
    //   let host = 'connected';
    //   try {
    //     host = new URL(hsync.con.hsyncServer).hostname;
    //   } catch (e) {}
    //   node.status({fill:'green',shape:'dot',text: host});
    // });

  }
  RED.nodes.registerType('hs-p2p-in', HsyncP2PIn);

  function HsyncP2POut(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const hsync = RED.nodes.getNode(config.connection);
    const hsyncPeer = RED.nodes.getNode(config.peer);
    const conShortName = hsync.hsu.hostname.split('.')[0];
    const peerShortName = hsyncPeer.hsu.hostname.split('.')[0];
    
    const peer = hsync.con.getPeer(hsyncPeer.host);
    peerCons[hsyncPeer.hsu.hostname] = peerCons[hsyncPeer.hsu.hostname] || peer;

    // console.log('HsyncP2POut', hsync.hsyncServer, '→', hsyncPeer.host, peer.dcOpen, peer.rtcStatus);



    if (peer.dcOpen) {
      // console.log('dcOpen already open', hsyncPeer.host);
      const text = `${peerShortName} → ${conShortName}`;
      node.status({fill:'green',shape:'dot',text});
    }

    peer.rtcEvents.on('dcOpen', () => { 
      // console.log('dcOpen to', hsyncPeer.host);
      const text = `${conShortName} → ${peerShortName}`;
      node.status({fill:'green',shape:'dot',text});
    });

    if (peer.rtcStatus === 'error') {
      // console.log('RTC ERROR', hsyncPeer.host);
      node.status({fill:'red',shape:'ring',text:'error'});
    }

    if (peer.rtcStatus === 'connecting') {
      // console.log('RTC CONNECTING', hsyncPeer.host);
      node.status({fill:'yellow',shape:'ring',text:'connecting...'});
    }

    peer.rtcEvents.on('closed', () => {
      node.status({fill:'red',shape:'ring',text:'closed'});
    });

    peer.rtcEvents.on('disconnected', () => {
      node.status({fill:'red',shape:'ring',text:'disconnected'});
    });

    if (!peer.dcOpen && peer.rtcStatus !== 'connecting') {
      node.status({fill:'yellow',shape:'ring',text:'connecting...'});
      console.log('connecting rtc');
      peer.connectRTC()
      .then(() => {
        console.log('then, connected rtc');
      })
      .catch((e) => {
        console.log('err, connect rtc', e);
        node.error(e);
      });
    }

    node.on('input', async function(msg) {
      console.log('hsync-p2p-in', msg, peer.dcOpen);
      if (peer.dcOpen) {
        if (!msg.from) {
          msg.from = hsync.con.hsyncServer;
        }
        if (!msg.topic) {
          msg.topic = 'json RTC msg'
        }
        peer.sendJSONMsg(msg);
      }
    });
    
    hsync.on('error', () => {
      node.status({fill:'red',shape:'ring',text:'error'});
    });

    // hsync.con.on('connected', () => {
    //   let host = 'connected';
    //   try {
    //     host = new URL(hsync.con.hsyncServer).hostname;
    //   } catch (e) {}
    //   node.status({fill:'green',shape:'dot',text: host});
    // });
  }
  RED.nodes.registerType('hs-p2p-out', HsyncP2POut);
}