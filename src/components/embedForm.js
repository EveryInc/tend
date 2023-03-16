import React, { useState } from 'react';
import axios from 'axios';

function EmbedForm() {
  const [url, setUrl] = useState('');

  const handleSubmit = async (event) => {
    event.preventDefault();
    const formData = new FormData();
    formData.append('url', url);
    formData.append('metadata', 'some metadata');

    try {
      await axios.post('/embed', formData);
      alert('URL submitted successfully!');
      setUrl('');
    } catch (error) {
      alert(`Error submitting URL: ${error.message}`);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <label>
        URL:
        <input
          type="text"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      <button type="submit">Submit</button>
    </form>
  );
}

export default EmbedForm;