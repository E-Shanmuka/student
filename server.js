// server.js
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const path = require('path');
const http = require('http');
const multer = require('multer');
const { Op } = require('sequelize');

const sequelize = require('./db.js');
const User = require('./models/user.js');
const Blog = require('./models/blog.js');
const Group = require('./models/group.js');

const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server);
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: 'secret-key',
  resave: false,
  saveUninitialized: true
}));

// Serve static files from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Authentication middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.user) next();
  else res.redirect('/');
}

// Routes

// Login page
app.get('/', (req, res) => {
  if(req.session.user) return res.redirect('/home');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Registration page
app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

// Handle registration
app.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  try {
    const existing = await User.findOne({ where: { username } });
    if(existing) return res.send("Username already exists.");
    const newUser = await User.create({ username, email, password });
    req.session.user = { id: newUser.id, username: newUser.username, email: newUser.email };
    res.redirect('/home');
  } catch(err) {
    console.error(err);
    res.send("Registration error.");
  }
});

// Handle login
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await User.findOne({ where: { username, password } });
    if(user) {
      req.session.user = { id: user.id, username: user.username, email: user.email };
      res.redirect('/home');
    } else {
      res.send("Invalid credentials.");
    }
  } catch(err) {
    console.error(err);
    res.send("Login error.");
  }
});

// Home page – blogs & search
app.get('/home', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

// Friend page – private chat
app.get('/friend', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'friend.html'));
});

// Group page – group chat, screen share, whiteboard, mic on/off
app.get('/group', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'group.html'));
});

// Admin page – view and manage (delete)
app.get('/admin', requireAuth, async (req, res) => {
  // For demo: first registered user is admin.
  const adminUser = await User.findOne({ order: [['id', 'ASC']] });
  if(req.session.user.username !== adminUser.username) return res.send("Access denied.");
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// API endpoints for admin data (GET and DELETE)
app.get('/api/users', requireAuth, async (req, res) => {
  const users = await User.findAll();
  res.json(users);
});
app.delete('/api/users/:id', requireAuth, async (req, res) => {
  try {
    await User.destroy({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/blogs', requireAuth, async (req, res) => {
  const blogs = await Blog.findAll({ order: [['id', 'DESC']] });
  res.json(blogs);
});
app.delete('/api/blogs/:id', requireAuth, async (req, res) => {
  try {
    await Blog.destroy({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/groups', requireAuth, async (req, res) => {
  const groups = await Group.findAll({ order: [['id', 'DESC']] });
  res.json(groups);
});
app.delete('/api/groups/:id', requireAuth, async (req, res) => {
  try {
    await Group.destroy({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// File upload endpoint for blog images
const storage = multer.diskStorage({
  destination: function(req, file, cb) { cb(null, 'public/uploads/'); },
  filename: function(req, file, cb) { cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname)); }
});
const upload = multer({ storage: storage });
app.post('/upload', upload.single('blogImage'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const fileUrl = `/uploads/${req.file.filename}`;
  res.json({ url: fileUrl });
});

// User search endpoint
app.get('/search/users', requireAuth, async (req, res) => {
  const q = req.query.q;
  try {
    const results = await User.findAll({ where: { username: { [Op.like]: `%${q}%` } } });
    res.json(results);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Socket.IO events ---

// In-memory mapping: username -> socket.id
const onlineUsers = {};

io.on('connection', (socket) => {
  console.log("Socket connected: " + socket.id);
  
  // Register user (from client)
  socket.on('register user', (data) => {
    onlineUsers[data.username] = socket.id;
  });
  
  socket.on('disconnect', () => {
    for (const [username, id] of Object.entries(onlineUsers)) {
      if (id === socket.id) { delete onlineUsers[username]; break; }
    }
    console.log("Socket disconnected: " + socket.id);
  });
  
  // Public chat (for friend page group messages)
  socket.on('chat message', (data) => {
    // data: { from, message }
    io.emit('chat message', data);
  });
  
  // Private message
  socket.on('private message', (data) => {
    // data: { from, to, message }
    const targetId = onlineUsers[data.to];
    if(targetId) {
      io.to(targetId).emit('private message', data);
      socket.emit('private message', data); // also echo to sender
    }
  });
  
  // Blog creation
  socket.on('create blog', async (data) => {
    try {
      const newBlog = await Blog.create({
        username: data.username,
        content: data.content,
        image: data.image
      });
      io.emit('new blog', newBlog);
    } catch(err) { console.error(err); }
  });
  
  // Blog like
  socket.on('blog like', async (data) => {
    try {
      const blog = await Blog.findByPk(data.blogId);
      if(blog) { blog.likes++; await blog.save(); io.emit('blog updated', blog); }
    } catch(err) { console.error(err); }
  });
  
  // Blog comment
  socket.on('blog comment', (data) => { io.emit('blog comment', data); });
  
  // Group chat message
  socket.on('group message', (data) => { io.emit('group message', data); });
  
  // Create group
  socket.on('create group', async (data) => {
    try {
      const group = await Group.create({ groupName: data.groupName });
      io.emit('new group', group);
    } catch(err) { console.error(err); }
  });
  
  // Screen share signal (placeholder)
  socket.on('screen share', (data) => { io.emit('screen share', data); });
  
  // Whiteboard drawing signal
  socket.on('whiteboard draw', (data) => { socket.broadcast.emit('whiteboard draw', data); });
  
  // Mic on/off event (notify others)
  socket.on('mic toggle', (data) => { io.emit('mic toggle', data); });
});

sequelize.sync()
  .then(() => { server.listen(PORT, () => console.log(`Server running on port ${PORT}`)); })
  .catch(err => console.error("DB sync error:", err));
